(function () {
    "use strict";

    const { practiceQuestions, POINTS_BY_DIFF, STORAGE_KEY } = window.SQL_ACADEMY_DATA;

    let activeQuestionIndex = null;
    let db = null;
    let schemaDocs = [];
    let schemaDiagramRendered = false;
    let schemaDiagramPanZoomDestroy = null;

    function loadProgressFromStorage() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { completed: new Set(), score: 0 };
            const data = JSON.parse(raw);
            return { completed: new Set(data.completed || []), score: data.score || 0 };
        } catch (e) {
            return { completed: new Set(), score: 0 };
        }
    }

    let progress = loadProgressFromStorage();

    function saveProgressToStorage() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            completed: [...progress.completed],
            score: progress.score
        }));
    }

    function getPointsForQuestion(q) {
        return POINTS_BY_DIFF[q.diff] ?? 0;
    }

    function buildSqlHintTables() {
        const tables = {};
        for (let i = 0; i < schemaDocs.length; i++) {
            const item = schemaDocs[i];
            tables[item.table] = item.cols;
        }
        return tables;
    }

    function updateSqlHintOptions() {
        editor.setOption("hintOptions", {
            tables: buildSqlHintTables(),
            completeSingle: false
        });
    }

    function showSqlAutocomplete(cm) {
        if (typeof CodeMirror.showHint !== "function" || !CodeMirror.hint || !CodeMirror.hint.sql) return;
        CodeMirror.showHint(cm, CodeMirror.hint.sql, {
            completeSingle: false,
            tables: buildSqlHintTables()
        });
    }

    const editorTextArea = document.getElementById("sql-editor");
    const editor = CodeMirror.fromTextArea(editorTextArea, {
        mode: "text/x-sql",
        theme: "idea",
        lineNumbers: true,
        indentUnit: 4,
        matchBrackets: true,
        hintOptions: {
            tables: {},
            completeSingle: false
        },
        extraKeys: {
            "Ctrl-Enter": function () { executeQuery(); },
            "Cmd-Enter": function () { executeQuery(); },
            "Ctrl-Shift-Enter": function () { checkAnswer(); },
            "Cmd-Shift-Enter": function () { checkAnswer(); },
            "Ctrl-Space": showSqlAutocomplete
        }
    });

    let sqlHintDebounceTimer = null;
    editor.on("inputRead", function (cm, change) {
        if (change.origin === "complete" || change.origin === "setValue") return;
        const inserted = change.text[change.text.length - 1];
        if (!inserted || !/[\w.]/.test(inserted)) return;
        clearTimeout(sqlHintDebounceTimer);
        sqlHintDebounceTimer = setTimeout(function () {
            if (cm.state.completionActive) return;
            showSqlAutocomplete(cm);
        }, 380);
    });

    const runBtn = document.getElementById("run-btn");
    const checkAnswerBtn = document.getElementById("check-answer-btn");
    const resultsOutput = document.getElementById("results-output");
    const rowCountEl = document.getElementById("row-count");
    const statusEl = document.getElementById("status");
    const schemaContainer = document.getElementById("schema-container");
    const schemaListPanel = document.getElementById("schema-list-panel");
    const mainDiagramWorkspace = document.getElementById("main-diagram-workspace");
    const schemaDiagramMount = document.getElementById("schema-diagram-mount");
    const schemaSubtabList = document.getElementById("schema-subtab-list");
    const schemaSubtabDiagram = document.getElementById("schema-subtab-diagram");
    const sqlSplitRoot = document.getElementById("sql-split-root");
    const practiceContainer = document.getElementById("practice-container");
    const practiceTabWrapper = document.getElementById("practice-tab-wrapper");
    const emptyStateEl = document.getElementById("empty-state");
    const gradeFeedbackEl = document.getElementById("grade-feedback");

    const tabSchemaBtn = document.getElementById("tab-schema-btn");
    const tabPracticeBtn = document.getElementById("tab-practice-btn");

    const qPanel = document.getElementById("active-question-panel");
    const qDiff = document.getElementById("q-diff");
    const qTitle = document.getElementById("q-title");
    const qText = document.getElementById("q-text");
    const qPoints = document.getElementById("q-points");
    const showAnswerBtn = document.getElementById("show-answer-btn");
    const closeQuestionBtn = document.getElementById("close-question-btn");
    const resetProgressBtn = document.getElementById("reset-progress-btn");

    const NUM_QUESTIONS = practiceQuestions.length;
    document.getElementById("total-questions").textContent = String(NUM_QUESTIONS);

    editor.setValue("-- Welcome to Northwind SQL Academy!\n" +
        "-- 1. Explore the schema on the left.\n" +
        "-- 2. Switch to the Practice tab to try challenges.\n" +
        "SELECT * FROM Customer LIMIT 10;");

    const EPS = 1e-9;

    function normalizeCell(val) {
        if (val === null || val === undefined) return { k: "n" };
        const s = String(val).trim();
        if (s === "") return { k: "s", v: "" };
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
            const num = Number(s);
            if (!Number.isNaN(num) && isFinite(num)) return { k: "f", v: num };
        }
        return { k: "s", v: s };
    }

    function cellsEqual(a, b) {
        if (a.k === "n" && b.k === "n") return true;
        if (a.k !== b.k) return false;
        if (a.k === "s") return a.v === b.v;
        if (a.k === "f") {
            const max = Math.max(Math.abs(a.v), Math.abs(b.v), 1);
            return Math.abs(a.v - b.v) < EPS * max;
        }
        return false;
    }

    function rowSortKey(cells) {
        return JSON.stringify(cells.map(c => {
            if (c.k === "n") return null;
            if (c.k === "f") return c.v;
            return c.v;
        }));
    }

    function normalizeRows(values) {
        return values.map(row => row.map(normalizeCell)).sort((a, b) => rowSortKey(a).localeCompare(rowSortKey(b)));
    }

    function compareResultSets(ref, user) {
        if (!ref.columns || !user.columns) {
            return { ok: false, reason: "Missing column metadata." };
        }
        if (ref.columns.length !== user.columns.length) {
            return { ok: false, reason: "Column count does not match." };
        }
        for (let i = 0; i < ref.columns.length; i++) {
            if (String(ref.columns[i]).toLowerCase() !== String(user.columns[i]).toLowerCase()) {
                return { ok: false, reason: "Column names or order do not match the expected result." };
            }
        }
        const rv = ref.values || [];
        const uv = user.values || [];
        if (rv.length !== uv.length) {
            return { ok: false, reason: "Row count does not match." };
        }
        const nr = normalizeRows(rv);
        const nu = normalizeRows(uv);
        for (let i = 0; i < nr.length; i++) {
            const ra = nr[i];
            const rb = nu[i];
            if (ra.length !== rb.length) return { ok: false, reason: "Row shape mismatch." };
            for (let j = 0; j < ra.length; j++) {
                if (!cellsEqual(ra[j], rb[j])) {
                    return { ok: false, reason: "Result data does not match the expected answer." };
                }
            }
        }
        return { ok: true };
    }

    function getFirstResultSet(execResult) {
        if (!execResult || execResult.length === 0) return { columns: [], values: [] };
        const first = execResult[0];
        return {
            columns: first.columns || [],
            values: first.values || []
        };
    }

    function hideGradeFeedback() {
        gradeFeedbackEl.classList.add("hidden");
        gradeFeedbackEl.innerHTML = "";
    }

    function showGradeFeedback(ok, message) {
        gradeFeedbackEl.classList.remove("hidden");
        gradeFeedbackEl.className = "px-4 py-2.5 text-sm font-medium border-b flex items-start gap-2 shrink-0 " +
            (ok ? "bg-emerald-50 text-emerald-900 border-emerald-100" : "bg-rose-50 text-rose-900 border-rose-100");
        gradeFeedbackEl.setAttribute("role", "status");
        gradeFeedbackEl.setAttribute("aria-live", "polite");
        gradeFeedbackEl.innerHTML = (ok
            ? `<i class="fas fa-check-circle mt-0.5 text-emerald-500" aria-hidden="true"></i><span>${escapeHtml(message)}</span>`
            : `<i class="fas fa-times-circle mt-0.5 text-rose-500" aria-hidden="true"></i><span>${escapeHtml(message)}</span>`);
    }

    function renderScoreStats(animateScore) {
        document.getElementById("score-value").textContent = String(progress.score);
        document.getElementById("completed-count").textContent = String(progress.completed.size);
        const el = document.getElementById("header-score");
        if (animateScore) {
            el.classList.add("score-updated");
            setTimeout(() => el.classList.remove("score-updated"), 500);
        }
    }

    renderScoreStats(false);

    function updateCheckAnswerButton() {
        const can = db && activeQuestionIndex !== null;
        checkAnswerBtn.disabled = !can;
    }

    function extractSchemaFromDB() {
        const schema = [];
        try {
            const tablesRes = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;");
            if (tablesRes.length > 0) {
                const tables = tablesRes[0].values.map(v => v[0]);
                tables.forEach(table => {
                    const colsRes = db.exec(`PRAGMA table_info("${table}");`);
                    if (colsRes.length > 0) {
                        const colMeta = colsRes[0].values.map(v => ({
                            name: v[1],
                            pk: Number(v[5]) === 1
                        }));
                        schema.push({ table, cols: colMeta.map(c => c.name), colMeta });
                    }
                });
            }
        } catch (err) {
            console.error("Error extracting schema:", err);
        }
        return schema;
    }

    function extractForeignKeyGroups() {
        const groups = [];
        if (!db) return groups;
        for (let i = 0; i < schemaDocs.length; i++) {
            const child = schemaDocs[i].table;
            const q = child.replace(/"/g, "\"\"");
            try {
                const fkRes = db.exec(`PRAGMA foreign_key_list("${q}");`);
                if (!fkRes.length) continue;
                const values = fkRes[0].values;
                const byFk = new Map();
                for (let j = 0; j < values.length; j++) {
                    const row = values[j];
                    const fkId = row[0];
                    const parent = String(row[2]);
                    const fromCol = String(row[3]);
                    const toRaw = row[4];
                    const toCol = toRaw != null && String(toRaw) !== "" ? String(toRaw) : "";
                    const key = child + "\0" + fkId;
                    if (!byFk.has(key)) {
                        byFk.set(key, { parent, child, pairs: [] });
                    }
                    byFk.get(key).pairs.push({ from: fromCol, to: toCol });
                }
                byFk.forEach(function (g) {
                    groups.push(g);
                });
            } catch (e) {
                console.error("foreign_key_list failed for " + child, e);
            }
        }
        return groups;
    }

    function mermaidSafeIdent(name) {
        const s = String(name);
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) return s;
        return "\"" + s.replace(/"/g, "\\\"") + "\"";
    }

    function buildMermaidER() {
        const lines = ["erDiagram"];
        let t = 0;
        for (t = 0; t < schemaDocs.length; t++) {
            const item = schemaDocs[t];
            const ent = mermaidSafeIdent(item.table);
            lines.push("    " + ent + " {");
            const meta = item.colMeta || item.cols.map(function (name) {
                return { name: name, pk: false };
            });
            let c = 0;
            for (c = 0; c < meta.length; c++) {
                const col = meta[c];
                const pkSuffix = col.pk ? " PK" : "";
                const rawName = String(col.name).replace(/"/g, "");
                lines.push("        string " + rawName + pkSuffix);
            }
            lines.push("    }");
        }
        const fkGroups = extractForeignKeyGroups();
        const relMerged = new Map();
        for (let g = 0; g < fkGroups.length; g++) {
            const grp = fkGroups[g];
            const rk = grp.parent + "\0" + grp.child;
            const label = grp.pairs.map(function (p) {
                return p.to ? p.from + "→" + p.to : p.from;
            }).join(", ");
            if (!relMerged.has(rk)) relMerged.set(rk, { parent: grp.parent, child: grp.child, labels: [] });
            relMerged.get(rk).labels.push(label);
        }
        relMerged.forEach(function (v) {
            const parent = mermaidSafeIdent(v.parent);
            const child = mermaidSafeIdent(v.child);
            const safeLabel = [...new Set(v.labels)].join(" | ").replace(/"/g, "'").slice(0, 160);
            lines.push("    " + parent + " ||--o{ " + child + " : \"" + safeLabel + "\"");
        });
        return lines.join("\n");
    }

    function destroySchemaDiagramPanZoom() {
        if (typeof schemaDiagramPanZoomDestroy === "function") {
            schemaDiagramPanZoomDestroy();
            schemaDiagramPanZoomDestroy = null;
        }
    }

    function setupSchemaDiagramPanZoom() {
        const viewport = document.getElementById("schema-diagram-viewport");
        const panLayer = document.getElementById("schema-diagram-pan-layer");
        if (!viewport || !panLayer) return;

        destroySchemaDiagramPanZoom();

        const MIN_SCALE = 0.12;
        const MAX_SCALE = 4;
        let scale = 1;
        let tx = 0;
        let ty = 0;

        function apply() {
            /* translate3d avoids some 2D layer raster paths; rounding reduces subpixel blur */
            const px = Math.round(tx * 100) / 100;
            const py = Math.round(ty * 100) / 100;
            const sc = Math.round(scale * 10000) / 10000;
            panLayer.style.transform = "translate3d(" + px + "px, " + py + "px, 0) scale(" + sc + ")";
        }

        function zoomAtScreen(sx, sy, factor) {
            const rect = viewport.getBoundingClientRect();
            const mx = sx - rect.left;
            const my = sy - rect.top;
            const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
            if (Math.abs(newScale - scale) < 1e-6) return;
            const ratio = newScale / scale;
            tx = mx - (mx - tx) * ratio;
            ty = my - (my - ty) * ratio;
            scale = newScale;
            apply();
        }

        function zoomCenter(factor) {
            const rect = viewport.getBoundingClientRect();
            zoomAtScreen(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
        }

        function fitToView() {
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    const vw = viewport.clientWidth;
                    const vh = viewport.clientHeight;
                    const cw = panLayer.scrollWidth;
                    const ch = panLayer.scrollHeight;
                    if (vw < 8 || vh < 8 || cw < 8 || ch < 8) return;
                    const s = Math.min(vw / cw, vh / ch, 1) * 0.92;
                    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
                    tx = (vw - cw * scale) / 2;
                    ty = (vh - ch * scale) / 2;
                    apply();
                });
            });
        }

        function onWheel(e) {
            e.preventDefault();
            const factor = Math.exp(-e.deltaY * 0.00115);
            zoomAtScreen(e.clientX, e.clientY, factor);
        }

        let dragging = false;
        let startX = 0;
        let startY = 0;
        let startTx = 0;
        let startTy = 0;

        function onPointerDown(e) {
            if (e.button !== 0) return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startTx = tx;
            startTy = ty;
            viewport.setPointerCapture(e.pointerId);
            viewport.classList.add("schema-diagram-dragging");
        }

        function onPointerMove(e) {
            if (!dragging) return;
            tx = startTx + (e.clientX - startX);
            ty = startTy + (e.clientY - startY);
            apply();
        }

        function onPointerUp(e) {
            if (!dragging) return;
            dragging = false;
            viewport.classList.remove("schema-diagram-dragging");
            try {
                viewport.releasePointerCapture(e.pointerId);
            } catch (ignore) { /* noop */ }
        }

        function onKeyDown(e) {
            if (document.activeElement !== viewport) return;
            if (e.key === "+" || e.key === "=") {
                e.preventDefault();
                zoomCenter(1.15);
            } else if (e.key === "-" || e.key === "_") {
                e.preventDefault();
                zoomCenter(1 / 1.15);
            } else if (e.key === "0") {
                e.preventDefault();
                fitToView();
            }
        }

        viewport.addEventListener("wheel", onWheel, { passive: false });
        viewport.addEventListener("pointerdown", onPointerDown);
        viewport.addEventListener("pointermove", onPointerMove);
        viewport.addEventListener("pointerup", onPointerUp);
        viewport.addEventListener("pointercancel", onPointerUp);

        viewport.addEventListener("keydown", onKeyDown);

        const btnIn = document.getElementById("diagram-zoom-in");
        const btnOut = document.getElementById("diagram-zoom-out");
        const btnFit = document.getElementById("diagram-zoom-reset");
        function onClickIn() {
            zoomCenter(1.2);
        }
        function onClickOut() {
            zoomCenter(1 / 1.2);
        }
        function onClickFit() {
            fitToView();
        }
        if (btnIn) btnIn.addEventListener("click", onClickIn);
        if (btnOut) btnOut.addEventListener("click", onClickOut);
        if (btnFit) btnFit.addEventListener("click", onClickFit);

        apply();
        fitToView();

        schemaDiagramPanZoomDestroy = function () {
            viewport.removeEventListener("wheel", onWheel);
            viewport.removeEventListener("pointerdown", onPointerDown);
            viewport.removeEventListener("pointermove", onPointerMove);
            viewport.removeEventListener("pointerup", onPointerUp);
            viewport.removeEventListener("pointercancel", onPointerUp);
            viewport.removeEventListener("keydown", onKeyDown);
            if (btnIn) btnIn.removeEventListener("click", onClickIn);
            if (btnOut) btnOut.removeEventListener("click", onClickOut);
            if (btnFit) btnFit.removeEventListener("click", onClickFit);
            viewport.classList.remove("schema-diagram-dragging");
        };
    }

    async function renderSchemaDiagram() {
        if (!schemaDiagramMount || schemaDiagramRendered) return;
        if (typeof mermaid === "undefined") {
            schemaDiagramMount.innerHTML = "<p class=\"text-sm text-rose-700 p-4\">Diagram library failed to load. Check your network connection.</p>";
            return;
        }
        try {
            mermaid.initialize({
                startOnLoad: false,
                theme: "neutral",
                securityLevel: "loose",
                er: { useMaxWidth: false }
            });
            const text = buildMermaidER();
            schemaDiagramMount.innerHTML = "";
            const el = document.createElement("div");
            el.className = "mermaid";
            el.textContent = text;
            schemaDiagramMount.appendChild(el);
            await mermaid.run({ nodes: [el] });
            schemaDiagramRendered = true;
            setupSchemaDiagramPanZoom();
            const vp = document.getElementById("schema-diagram-viewport");
            if (vp) vp.focus();
        } catch (err) {
            console.error("Mermaid render failed:", err);
            schemaDiagramMount.innerHTML = "<p class=\"text-sm text-rose-700 p-4\">Could not render the diagram. See the list view for tables and columns.</p>";
        }
    }

    function renderSchema() {
        schemaListPanel.innerHTML = schemaDocs.map(item => `
                <div class="mb-5">
                    <div class="font-semibold text-slate-800 cursor-pointer hover:text-indigo-600 flex items-center group transition-colors" onclick="insertTableName('${item.table}')">
                        <i class="fas fa-table text-slate-300 mr-2 text-xs group-hover:text-indigo-400 transition-colors"></i> ${item.table}
                    </div>
                    <div class="pl-5 mt-1.5 space-y-1">
                        ${item.cols.map(col => `
                            <div class="cursor-pointer text-slate-500 hover:text-indigo-500 hover:bg-indigo-50/50 rounded px-1.5 py-0.5 -ml-1.5 transition-colors flex items-center" onclick="insertColName('${col}')">
                                <span class="w-1 h-1 bg-slate-200 rounded-full mr-2"></span>${col}
                            </div>
                        `).join("")}
                    </div>
                </div>
            `).join("");
    }

    function syncSchemaSubtabs() {
        const listOn = !schemaListPanel.classList.contains("hidden");
        schemaSubtabList.setAttribute("aria-selected", listOn ? "true" : "false");
        schemaSubtabDiagram.setAttribute("aria-selected", listOn ? "false" : "true");
        schemaListPanel.setAttribute("aria-hidden", listOn ? "false" : "true");
        schemaSubtabList.classList.toggle("schema-subtab-active", listOn);
        schemaSubtabDiagram.classList.toggle("schema-subtab-active", !listOn);
    }

    function applySchemaMainWorkspace() {
        if (!sqlSplitRoot || !mainDiagramWorkspace) return;
        const practiceOn = practiceTabWrapper && !practiceTabWrapper.classList.contains("hidden");
        if (practiceOn) {
            sqlSplitRoot.classList.remove("hidden");
            mainDiagramWorkspace.classList.add("hidden");
            mainDiagramWorkspace.setAttribute("aria-hidden", "true");
            return;
        }
        const listOn = !schemaListPanel.classList.contains("hidden");
        if (listOn) {
            sqlSplitRoot.classList.remove("hidden");
            mainDiagramWorkspace.classList.add("hidden");
            mainDiagramWorkspace.setAttribute("aria-hidden", "true");
        } else {
            sqlSplitRoot.classList.add("hidden");
            mainDiagramWorkspace.classList.remove("hidden");
            mainDiagramWorkspace.setAttribute("aria-hidden", "false");
            renderSchemaDiagram();
            if (schemaDiagramRendered) {
                requestAnimationFrame(function () {
                    const v = document.getElementById("schema-diagram-viewport");
                    if (v) v.focus();
                });
            }
        }
    }

    function showSchemaListView() {
        schemaListPanel.classList.remove("hidden");
        syncSchemaSubtabs();
        applySchemaMainWorkspace();
        requestAnimationFrame(function () {
            if (typeof initEditorSplitHeight === "function") initEditorSplitHeight();
            editor.refresh();
        });
    }

    function showSchemaDiagramView() {
        schemaListPanel.classList.add("hidden");
        syncSchemaSubtabs();
        applySchemaMainWorkspace();
    }

    function diffBorderClass(diff) {
        if (diff === "Easy") return "border-l-emerald-500";
        if (diff === "Medium") return "border-l-amber-500";
        if (diff === "Hard") return "border-l-rose-500";
        if (diff === "Super Ultra") return "border-l-violet-500";
        if (diff === "Super Ultra Hard") return "border-l-fuchsia-600";
        if (diff === "Super Ultra Hard Max") return "border-l-orange-600";
        if (diff === "Super Ultra Hard Max Pro") return "border-l-teal-600";
        if (diff === "Super Ultra Hard Max Pro God") return "border-l-amber-500";
        return "border-l-slate-400";
    }

    function renderPracticeSets() {
        const searchTerm = document.getElementById("practice-search").value.toLowerCase();
        const diffFilter = document.getElementById("practice-diff-filter").value;

        practiceContainer.innerHTML = practiceQuestions.map((q, idx) => {
            if (diffFilter !== "All" && q.diff !== diffFilter) return "";
            if (searchTerm && !q.title.toLowerCase().includes(searchTerm) && !q.text.toLowerCase().includes(searchTerm)) return "";

            let diffClass = "";
            if (q.diff === "Easy") diffClass = "bg-emerald-100 text-emerald-800 border-emerald-200";
            if (q.diff === "Medium") diffClass = "bg-amber-100 text-amber-800 border-amber-200";
            if (q.diff === "Hard") diffClass = "bg-rose-100 text-rose-800 border-rose-200";
            if (q.diff === "Super Ultra") diffClass = "bg-purple-100 text-purple-800 border-purple-200";
            if (q.diff === "Super Ultra Hard") diffClass = "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-300";
            if (q.diff === "Super Ultra Hard Max") diffClass = "bg-orange-100 text-orange-950 border-orange-300";
            if (q.diff === "Super Ultra Hard Max Pro") diffClass = "bg-teal-100 text-teal-950 border-teal-400";
            if (q.diff === "Super Ultra Hard Max Pro God") diffClass = "bg-amber-100 text-amber-950 border-amber-500";

            const pts = getPointsForQuestion(q);
            const done = progress.completed.has(idx);
            const active = activeQuestionIndex === idx;

                return `
                <div role="listitem" class="p-3.5 bg-white border border-slate-200 border-l-4 ${diffBorderClass(q.diff)} rounded-xl hover:border-indigo-300 hover:shadow-md cursor-pointer transition-all group ${active ? "ring-2 ring-indigo-400 ring-offset-1" : ""} ${done ? "bg-emerald-50/40" : ""}" onclick="loadQuestion(${idx})" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();loadQuestion(${idx});}">
                    <div class="flex items-start justify-between gap-2 mb-1.5">
                        <div class="flex items-center flex-wrap gap-2 min-w-0">
                            <span class="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider border ${diffClass}">${q.diff}</span>
                            <span class="font-semibold text-slate-800 text-sm group-hover:text-indigo-700 transition-colors">${q.title}</span>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">+${pts}</span>
                            ${done ? '<span class="text-emerald-600" title="Completed"><i class="fas fa-check-circle"></i></span>' : ""}
                        </div>
                    </div>
                    <div class="text-xs text-slate-500 line-clamp-2 leading-relaxed">${q.text}</div>
                </div>
                `;
        }).join("");
    }

    window.loadQuestion = function (index) {
        activeQuestionIndex = index;
        const q = practiceQuestions[index];

        qDiff.className = "text-[10px] uppercase font-bold px-2 py-0.5 rounded-md tracking-wide ";
        if (q.diff === "Easy") qDiff.className += "bg-emerald-200 text-emerald-900";
        if (q.diff === "Medium") qDiff.className += "bg-amber-200 text-amber-900";
        if (q.diff === "Hard") qDiff.className += "bg-rose-200 text-rose-900";
        if (q.diff === "Super Ultra") qDiff.className += "bg-purple-200 text-purple-900";
        if (q.diff === "Super Ultra Hard") qDiff.className += "bg-fuchsia-200 text-fuchsia-950";
        if (q.diff === "Super Ultra Hard Max") qDiff.className += "bg-orange-200 text-orange-950";
        if (q.diff === "Super Ultra Hard Max Pro") qDiff.className += "bg-teal-200 text-teal-950";
        if (q.diff === "Super Ultra Hard Max Pro God") qDiff.className += "bg-amber-300 text-amber-950";

        qDiff.innerText = q.diff;
        qTitle.innerText = q.title;
        qText.innerText = q.text;
        qPoints.textContent = "+" + getPointsForQuestion(q) + " pts";

        qPanel.classList.remove("hidden");

        editor.setValue(`-- Practice: ${q.title}\n\n`);
        editor.focus();
        hideGradeFeedback();
        updateCheckAnswerButton();
        renderPracticeSets();
    };

    window.insertTableName = function (name) {
        const safeName = name.includes(" ") ? `"${name}"` : name;
        editor.setValue(`SELECT * FROM ${safeName} LIMIT 10;`);
        editor.focus();
    };

    window.insertColName = function (name) {
        const safeName = name.includes(" ") ? `"${name}"` : name;
        editor.replaceSelection(safeName);
        editor.focus();
    };

    function showResultsPanel(html) {
        emptyStateEl.style.display = "none";
        resultsOutput.classList.remove("hidden");
        resultsOutput.innerHTML = html;
    }

    function renderSuccessNoRows() {
        showResultsPanel(`
                <div class="m-4 p-4 bg-emerald-50 rounded-lg border border-emerald-100 flex items-start text-emerald-800">
                    <i class="fas fa-check-circle mt-0.5 mr-3 text-emerald-500"></i>
                    <div>
                        <h4 class="text-sm font-semibold">Success</h4>
                        <p class="text-xs mt-0.5 opacity-80">Query executed successfully. No rows to display.</p>
                    </div>
                </div>`);
    }

    function renderResultTable(res) {
        if (res.length === 0) {
            rowCountEl.innerText = "0 rows";
            renderSuccessNoRows();
            return;
        }
        const columns = res[0].columns;
        const values = res[0].values || [];
        rowCountEl.innerText = `${values.length} row${values.length !== 1 ? "s" : ""}`;

        let tableHTML = "<table><thead><tr>";
        columns.forEach(col => { tableHTML += `<th>${escapeHtml(col)}</th>`; });
        tableHTML += "</tr></thead><tbody>";

        values.forEach(row => {
            tableHTML += "<tr>";
            row.forEach(val => {
                tableHTML += `<td>${val === null ? '<span class="text-slate-400 italic text-xs">null</span>' : escapeHtml(String(val))}</td>`;
            });
            tableHTML += "</tr>";
        });
        tableHTML += "</tbody></table>";
        showResultsPanel(tableHTML);
    }

    function renderSqlError(error) {
        rowCountEl.classList.remove("hidden");
        rowCountEl.innerText = "Error";
        showResultsPanel(`
                <div class="m-4 p-4 bg-rose-50 text-rose-800 rounded-lg border border-rose-100 flex items-start">
                    <i class="fas fa-exclamation-triangle mt-0.5 mr-3 text-rose-500"></i>
                    <div>
                        <h4 class="text-sm font-semibold">SQL Error</h4>
                        <p class="font-mono text-xs mt-1.5 text-rose-600/90 whitespace-pre-wrap">${escapeHtml(error.message)}</p>
                    </div>
                </div>
            `);
    }

    function executeQuery() {
        if (!db) return;
        const query = editor.getValue().trim();
        if (!query) return;

        hideGradeFeedback();

        try {
            const res = db.exec(query);
            rowCountEl.classList.remove("hidden");
            renderResultTable(res);
        } catch (error) {
            renderSqlError(error);
        }
    }

    function checkAnswer() {
        if (!db || activeQuestionIndex === null) return;
        const query = editor.getValue().trim();
        if (!query) return;

        const q = practiceQuestions[activeQuestionIndex];
        let userExec;
        try {
            userExec = db.exec(query);
        } catch (error) {
            renderSqlError(error);
            showGradeFeedback(false, "Fix SQL errors before your answer can be checked.");
            return;
        }

        rowCountEl.classList.remove("hidden");
        renderResultTable(userExec);

        let refExec;
        try {
            refExec = db.exec(q.sql);
        } catch (e) {
            showGradeFeedback(false, "Reference solution failed unexpectedly.");
            console.error(e);
            return;
        }

        const refSet = getFirstResultSet(refExec);
        const userSet = getFirstResultSet(userExec);
        const cmp = compareResultSets(refSet, userSet);

        if (cmp.ok) {
            const idx = activeQuestionIndex;
            const wasNew = !progress.completed.has(idx);
            if (wasNew) {
                const pts = getPointsForQuestion(q);
                progress.completed.add(idx);
                progress.score += pts;
                saveProgressToStorage();
                renderScoreStats(true);
                renderPracticeSets();
                showGradeFeedback(true, `Correct! +${pts} points.`);
                if (typeof confetti === "function") {
                    confetti({ particleCount: 130, spread: 68, origin: { y: 0.72 }, scalar: 0.95 });
                }
            } else {
                showGradeFeedback(true, "Correct! (Already completed — no extra points.)");
            }
        } else {
            showGradeFeedback(false, cmp.reason || "Results don't match the expected answer.");
        }
    }

    function escapeHtml(unsafe) {
        return String(unsafe)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    runBtn.disabled = true;
    checkAnswerBtn.disabled = true;

    const config = { locateFile: filename => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${filename}` };

    initSqlJs(config).then(async function (SQL) {
        db = new SQL.Database();
        try {
            statusEl.innerHTML = `<i class="fas fa-database animate-pulse text-indigo-400"></i><span>Loading database…</span>`;
            const response = await fetch("northwind_core.sql");

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const sqlText = await response.text();
            statusEl.innerHTML = `<i class="fas fa-cog fa-spin text-indigo-400"></i><span>Building Engine...</span>`;

            setTimeout(() => {
                try {
                    db.run(sqlText);
                    schemaDocs = extractSchemaFromDB();
                    updateSqlHintOptions();

                    statusEl.innerHTML = `<i class="fas fa-check-circle text-emerald-400"></i><span>System Ready</span>`;
                    statusEl.classList.replace("bg-slate-800", "bg-slate-800/80");
                    statusEl.classList.replace("border-slate-700", "border-emerald-500/30");
                    runBtn.disabled = false;
                    updateCheckAnswerButton();

                    renderSchema();
                    renderPracticeSets();
                } catch (err) {
                    statusEl.innerHTML = `<i class="fas fa-times-circle text-rose-400"></i><span>Build Failed</span>`;
                    statusEl.classList.replace("border-slate-700", "border-rose-500/30");
                }
            }, 50);

        } catch (err) {
            statusEl.innerHTML = `<i class="fas fa-times-circle text-rose-400"></i><span>Could not load northwind_core.sql</span>`;
            statusEl.classList.replace("border-slate-700", "border-rose-500/30");
        }
    });

    function syncTabAccessibility() {
        const schemaVisible = !schemaContainer.classList.contains("hidden");
        tabSchemaBtn.setAttribute("aria-selected", schemaVisible ? "true" : "false");
        tabPracticeBtn.setAttribute("aria-selected", schemaVisible ? "false" : "true");
        schemaContainer.setAttribute("aria-hidden", schemaVisible ? "false" : "true");
        practiceTabWrapper.setAttribute("aria-hidden", schemaVisible ? "true" : "false");
    }

    runBtn.addEventListener("click", executeQuery);
    checkAnswerBtn.addEventListener("click", checkAnswer);

    schemaSubtabList.addEventListener("click", function () {
        showSchemaListView();
    });
    schemaSubtabDiagram.addEventListener("click", function () {
        showSchemaDiagramView();
    });

    tabSchemaBtn.addEventListener("click", () => {
        tabSchemaBtn.classList.add("tab-active", "shadow-sm");
        tabPracticeBtn.classList.remove("tab-active", "shadow-sm");
        schemaContainer.classList.remove("hidden");
        practiceTabWrapper.classList.add("hidden");
        practiceTabWrapper.classList.remove("flex");
        syncTabAccessibility();
        applySchemaMainWorkspace();
        requestAnimationFrame(function () {
            if (typeof initEditorSplitHeight === "function") initEditorSplitHeight();
            editor.refresh();
        });
    });

    tabPracticeBtn.addEventListener("click", () => {
        tabPracticeBtn.classList.add("tab-active", "shadow-sm");
        tabSchemaBtn.classList.remove("tab-active", "shadow-sm");
        practiceTabWrapper.classList.remove("hidden");
        practiceTabWrapper.classList.add("flex");
        schemaContainer.classList.add("hidden");
        syncTabAccessibility();
        applySchemaMainWorkspace();
        requestAnimationFrame(function () {
            if (typeof initEditorSplitHeight === "function") initEditorSplitHeight();
            editor.refresh();
        });
    });

    syncTabAccessibility();
    syncSchemaSubtabs();
    applySchemaMainWorkspace();

    document.getElementById("practice-search").addEventListener("input", renderPracticeSets);
    document.getElementById("practice-diff-filter").addEventListener("change", renderPracticeSets);

    closeQuestionBtn.addEventListener("click", () => {
        qPanel.classList.add("hidden");
        activeQuestionIndex = null;
        hideGradeFeedback();
        updateCheckAnswerButton();
        renderPracticeSets();
    });

    showAnswerBtn.addEventListener("click", () => {
        if (activeQuestionIndex !== null) {
            const q = practiceQuestions[activeQuestionIndex];
            editor.setValue(`-- Solution for: ${q.title}\n${q.sql}`);
            executeQuery();
        }
    });

    resetProgressBtn.addEventListener("click", () => {
        if (!confirm("Reset all progress and score? This cannot be undone.")) return;
        progress = { completed: new Set(), score: 0 };
        localStorage.removeItem(STORAGE_KEY);
        renderScoreStats(false);
        renderPracticeSets();
        hideGradeFeedback();
    });

    const sqlEditorPanel = document.getElementById("sql-editor-panel");
    const resultsPanel = document.getElementById("results-panel");
    const editorResizeHandle = document.getElementById("editor-resize-handle");
    const MIN_EDITOR_SPLIT = 120;
    const MIN_RESULTS_SPLIT = 120;

    function clampEditorSplitHeight(px) {
        if (!sqlSplitRoot || !editorResizeHandle) return px;
        const rootH = sqlSplitRoot.getBoundingClientRect().height;
        const gapTotal = 8;
        const handleH = editorResizeHandle.offsetHeight;
        const maxEditor = Math.max(MIN_EDITOR_SPLIT, rootH - handleH - gapTotal - MIN_RESULTS_SPLIT);
        return Math.min(Math.max(px, MIN_EDITOR_SPLIT), maxEditor);
    }

    function setEditorSplitHeight(px) {
        if (!sqlEditorPanel) return;
        const h = clampEditorSplitHeight(px);
        sqlEditorPanel.style.flex = "0 0 " + h + "px";
        editor.refresh();
    }

    function initEditorSplitHeight() {
        if (!sqlSplitRoot || !sqlEditorPanel || !editorResizeHandle) return;
        if (sqlSplitRoot.classList.contains("hidden")) return;
        const rootH = sqlSplitRoot.getBoundingClientRect().height;
        if (rootH < MIN_EDITOR_SPLIT * 2) return;
        const gapTotal = 8;
        const handleH = editorResizeHandle.offsetHeight;
        const available = rootH - handleH - gapTotal;
        setEditorSplitHeight(Math.round(available * 0.45));
    }

    if (sqlSplitRoot && sqlEditorPanel && editorResizeHandle && resultsPanel) {
        editorResizeHandle.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const startY = e.clientY;
            const startH = sqlEditorPanel.getBoundingClientRect().height;
            function onMove(moveEvent) {
                setEditorSplitHeight(startH + (moveEvent.clientY - startY));
            }
            function onUp() {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            }
            document.body.style.cursor = "ns-resize";
            document.body.style.userSelect = "none";
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        editorResizeHandle.addEventListener("keydown", (e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const step = e.shiftKey ? 40 : 12;
            const delta = e.key === "ArrowUp" ? -step : step;
            const cur = sqlEditorPanel.getBoundingClientRect().height;
            setEditorSplitHeight(cur + delta);
        });

        window.addEventListener("resize", () => {
            if (sqlSplitRoot.classList.contains("hidden")) return;
            const cur = sqlEditorPanel.getBoundingClientRect().height;
            setEditorSplitHeight(clampEditorSplitHeight(cur));
        });

        let splitResizeScheduled = false;
        const splitResizeObserver = new ResizeObserver(() => {
            if (sqlSplitRoot.classList.contains("hidden")) return;
            if (splitResizeScheduled) return;
            splitResizeScheduled = true;
            requestAnimationFrame(() => {
                splitResizeScheduled = false;
                const cur = sqlEditorPanel.getBoundingClientRect().height;
                setEditorSplitHeight(clampEditorSplitHeight(cur));
            });
        });
        splitResizeObserver.observe(sqlSplitRoot);

        initEditorSplitHeight();
        requestAnimationFrame(() => {
            initEditorSplitHeight();
            editor.refresh();
        });
    }
})();
