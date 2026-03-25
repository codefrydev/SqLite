(function () {
    "use strict";

    const { practiceQuestions, POINTS_BY_DIFF, STORAGE_KEY } = window.SQL_ACADEMY_DATA;

    let activeQuestionIndex = null;
    let db = null;
    let schemaDocs = [];

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

    const editorTextArea = document.getElementById("sql-editor");
    const editor = CodeMirror.fromTextArea(editorTextArea, {
        mode: "text/x-sql",
        theme: "idea",
        lineNumbers: true,
        indentUnit: 4,
        matchBrackets: true,
        extraKeys: {
            "Ctrl-Enter": function () { executeQuery(); },
            "Cmd-Enter": function () { executeQuery(); },
            "Ctrl-Shift-Enter": function () { checkAnswer(); },
            "Cmd-Shift-Enter": function () { checkAnswer(); }
        }
    });

    const runBtn = document.getElementById("run-btn");
    const checkAnswerBtn = document.getElementById("check-answer-btn");
    const resultsOutput = document.getElementById("results-output");
    const rowCountEl = document.getElementById("row-count");
    const statusEl = document.getElementById("status");
    const schemaContainer = document.getElementById("schema-container");
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
                        const cols = colsRes[0].values.map(v => v[1]);
                        schema.push({ table, cols });
                    }
                });
            }
        } catch (err) {
            console.error("Error extracting schema:", err);
        }
        return schema;
    }

    function renderSchema() {
        schemaContainer.innerHTML = schemaDocs.map(item => `
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

    tabSchemaBtn.addEventListener("click", () => {
        tabSchemaBtn.classList.add("tab-active", "shadow-sm");
        tabPracticeBtn.classList.remove("tab-active", "shadow-sm");
        schemaContainer.classList.remove("hidden");
        practiceTabWrapper.classList.add("hidden");
        practiceTabWrapper.classList.remove("flex");
        syncTabAccessibility();
    });

    tabPracticeBtn.addEventListener("click", () => {
        tabPracticeBtn.classList.add("tab-active", "shadow-sm");
        tabSchemaBtn.classList.remove("tab-active", "shadow-sm");
        practiceTabWrapper.classList.remove("hidden");
        practiceTabWrapper.classList.add("flex");
        schemaContainer.classList.add("hidden");
        syncTabAccessibility();
    });

    syncTabAccessibility();

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
})();
