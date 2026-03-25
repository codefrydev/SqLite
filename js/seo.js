/**
 * Canonical URL, Open Graph URL, and JSON-LD (WebSite, WebPage, LearningResource, FAQPage, ItemList of practice questions).
 */
(function () {
    "use strict";

    var baseUrl = window.location.href.split("#")[0].replace(/\/?$/, "/");

    var canonical = document.getElementById("canonical-url");
    if (canonical) canonical.setAttribute("href", baseUrl);

    var ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute("content", baseUrl);

    var data = window.SQL_ACADEMY_DATA;
    if (!data || !data.practiceQuestions) return;

    var siteName = "Northwind SQL Academy";
    var description = document.querySelector('meta[name="description"]');
    var descText = description ? description.getAttribute("content") : "Interactive SQL tutorials and practice challenges on the Northwind database in your browser.";

    var faqItems = [
        {
            q: "What is Northwind SQL Academy?",
            a: "It is a free, browser-based SQL learning app. You write queries against a real Northwind sample database loaded with SQL.js (SQLite in WebAssembly), see results in a grid, and complete scored practice challenges from easy to expert levels."
        },
        {
            q: "Which database engine is used?",
            a: "The app uses SQLite via SQL.js. The schema and data come from a Northwind SQL script (northwind_core.sql) loaded locally in your browser—no server-side database is required."
        },
        {
            q: "How do I check if my answer is correct?",
            a: "Open a challenge from the Practice tab, write your SQL, then click Check answer (or use the keyboard shortcut). Your result set is compared to the reference solution. Run executes the query without grading."
        },
        {
            q: "How does scoring work?",
            a: "Points depend on difficulty (from Easy up to Super Ultra Hard Max Pro). You earn points once per challenge on first correct check. Progress is saved in your browser (localStorage). You can reset progress from the header."
        },
        {
            q: "Do I need to install anything?",
            a: "No. Serve the project folder over HTTP (for example with a local static server) and open the page in a modern browser. The SQL file and scripts load from the same origin."
        },
        {
            q: "Is my data private?",
            a: "Queries run entirely in your browser. Progress is stored only in localStorage on your device and is not sent to a server."
        }
    ];

    var itemListElements = data.practiceQuestions.map(function (q, i) {
        return {
            "@type": "ListItem",
            "position": i + 1,
            "name": q.title,
            "description": q.text,
            "item": {
                "@type": "Question",
                "name": q.title,
                "text": q.text,
                "educationalLevel": q.diff
            }
        };
    });

    var faqMainEntity = faqItems.map(function (item) {
        return {
            "@type": "Question",
            "name": item.q,
            "acceptedAnswer": {
                "@type": "Answer",
                "text": item.a
            }
        };
    });

    var graph = [
        {
            "@type": "WebSite",
            "@id": baseUrl + "#website",
            "name": siteName,
            "url": baseUrl,
            "description": descText,
            "inLanguage": "en",
            "publisher": { "@id": baseUrl + "#organization" }
        },
        {
            "@type": "Organization",
            "@id": baseUrl + "#organization",
            "name": siteName,
            "url": baseUrl
        },
        {
            "@type": "WebPage",
            "@id": baseUrl + "#webpage",
            "url": baseUrl,
            "name": siteName,
            "description": descText,
            "isPartOf": { "@id": baseUrl + "#website" },
            "about": { "@id": baseUrl + "#learning-resource" },
            "mainEntity": { "@id": baseUrl + "#challenge-list" }
        },
        {
            "@type": "LearningResource",
            "@id": baseUrl + "#learning-resource",
            "name": siteName + " — SQL practice",
            "description": descText,
            "learningResourceType": "Interactive exercise",
            "educationalLevel": "Beginner through advanced",
            "teaches": "SQL, SQLite, SELECT, JOINs, aggregates, window functions",
            "isAccessibleForFree": true,
            "inLanguage": "en"
        },
        {
            "@type": "FAQPage",
            "@id": baseUrl + "#faq",
            "mainEntity": faqMainEntity
        },
        {
            "@type": "ItemList",
            "@id": baseUrl + "#challenge-list",
            "name": "Northwind SQL practice challenges",
            "description": "Catalog of interactive SQL questions with difficulty levels and points.",
            "numberOfItems": itemListElements.length,
            "itemListElement": itemListElements
        }
    ];

    var ld = {
        "@context": "https://schema.org",
        "@graph": graph
    };

    var script = document.createElement("script");
    script.type = "application/ld+json";
    script.setAttribute("data-source", "northwind-sql-academy");
    script.textContent = JSON.stringify(ld);
    document.head.appendChild(script);

    var skip = document.querySelector(".skip-link");
    var mainEl = document.getElementById("main-content");
    if (skip && mainEl) {
        skip.addEventListener("click", function (e) {
            e.preventDefault();
            mainEl.setAttribute("tabindex", "-1");
            mainEl.focus({ preventScroll: false });
            try {
                history.replaceState(null, "", baseUrl.split("?")[0].split("#")[0] + "#main-content");
            } catch (err) { /* ignore */ }
        });
    }
})();
