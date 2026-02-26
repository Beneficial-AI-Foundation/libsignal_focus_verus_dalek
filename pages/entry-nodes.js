// Path prefixes that go through Git symlinks and need rewriting to the
// submodule's own GitHub repo.  Add entries here for other symlinks (e.g. spqr).
const SYMLINK_REWRITES = {
    "curve25519-dalek/": {
        base_url: "https://github.com/Beneficial-AI-Foundation/curve25519-dalek",
        branch: "main",
    },
};

function nodeCategory(n) {
    const p = (n.relative_path || "").toLowerCase();
    const name = (n.display_name || "").toLowerCase();
    const id = (n.id || "").toLowerCase();

    if (p.includes("/benches/") || p.includes("/bench/") ||
        p.endsWith("_bench.rs") || name.includes("::bench::") ||
        id.includes("::bench::") || id.includes("::benches::")) {
        return "bench";
    }
    if (p.includes("/tests/") || p.includes("/test/") ||
        p.endsWith("_test.rs") || p.endsWith("_tests.rs") ||
        name.includes("::tests::") || name.includes("::test::") ||
        id.includes("::tests::") || id.includes("::test::")) {
        return "test";
    }
    if (p.startsWith("rust/bridge/")) {
        return "api";
    }
    return "lib";
}

function crateName(node) {
    const p = node.relative_path || "";
    const srcIdx = p.indexOf("/src/");
    if (srcIdx > 0) return p.slice(0, srcIdx);
    return p.split("/").slice(0, 2).join("/") || "unknown";
}

let buckets = { api: [], lib: [], test: [], bench: [] };
let graphMetadata = {};
let sortKey = "display_name";
let sortAsc = true;

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const resp = await fetch("graph.json");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const graph = await resp.json();

        graphMetadata = graph.metadata || {};
        const nodes = graph.nodes || [];

        const libsignalEntry = nodes.filter(
            (n) => (!n.dependents || n.dependents.length === 0) && n.is_libsignal
        );

        for (const n of libsignalEntry) {
            buckets[nodeCategory(n)].push(n);
        }

        updateCounts();
        updateFooter();
        wireControls();
        renderAll();
    } catch (err) {
        for (const id of ["apiBody", "libBody", "testBody", "benchBody"]) {
            document.getElementById(id).innerHTML =
                `<tr><td colspan="4" class="error">Failed to load graph.json: ${escapeHtml(err.message)}</td></tr>`;
        }
        console.error("Entry nodes load error:", err);
    }
});

function updateCounts() {
    document.getElementById("apiCount").textContent = buckets.api.length;
    document.getElementById("libCount").textContent = buckets.lib.length;
    document.getElementById("testCount").textContent = buckets.test.length;
    document.getElementById("benchCount").textContent = buckets.bench.length;
    const total = buckets.api.length + buckets.lib.length + buckets.test.length + buckets.bench.length;
    document.getElementById("totalCount").textContent = total;
}

function wireControls() {
    document.getElementById("search").addEventListener("input", renderAll);

    document.querySelectorAll("th[data-sort]").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sort;
            if (sortKey === key) {
                sortAsc = !sortAsc;
            } else {
                sortKey = key;
                sortAsc = true;
            }
            document.querySelectorAll("th[data-sort]").forEach((h) => h.classList.remove("sorted"));
            document.querySelectorAll(`th[data-sort="${key}"]`).forEach((h) => {
                h.classList.add("sorted");
                h.querySelector(".sort-indicator").textContent = sortAsc ? "▲" : "▼";
            });
            renderAll();
        });
    });
}

function renderAll() {
    const query = (document.getElementById("search").value || "").toLowerCase().trim();
    renderTable(buckets.api, "apiBody", query);
    renderTable(buckets.lib, "libBody", query);
    renderTable(buckets.test, "testBody", query);
    renderTable(buckets.bench, "benchBody", query);
}

function renderTable(nodes, tbodyId, query) {
    let filtered = nodes;
    if (query) {
        filtered = filtered.filter(
            (n) =>
                (n.display_name || "").toLowerCase().includes(query) ||
                (n.id || "").toLowerCase().includes(query)
        );
    }

    filtered.sort((a, b) => {
        const ca = crateName(a).toLowerCase();
        const cb = crateName(b).toLowerCase();
        if (ca !== cb) return ca.localeCompare(cb);
        const va = (a[sortKey] || "").toLowerCase();
        const vb = (b[sortKey] || "").toLowerCase();
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    const tbody = document.getElementById(tbodyId);

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">None</td></tr>';
        return;
    }

    let html = "";
    let currentCrate = null;
    for (const n of filtered) {
        const crate = crateName(n);
        if (crate !== currentCrate) {
            currentCrate = crate;
            const count = filtered.filter((x) => crateName(x) === crate).length;
            html += `<tr class="group-header"><td colspan="4">${escapeHtml(crate)} <span class="group-count">${count}</span></td></tr>`;
        }
        const sourceHref = buildSourceLink(n);
        const graphHref = buildGraphLink(n);
        html += `<tr>
            <td class="col-name">${escapeHtml(n.display_name || "")}</td>
            <td class="col-id" title="${escapeAttr(n.id || "")}">${escapeHtml(n.id || "")}</td>
            <td>${sourceHref
                ? `<a class="source-link" href="${escapeAttr(sourceHref)}" target="_blank" rel="noopener">View source &nearr;</a>`
                : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td><a class="graph-link" href="${escapeAttr(graphHref)}" target="_blank" rel="noopener">Graph &nearr;</a></td>
        </tr>`;
    }
    tbody.innerHTML = html;
}

function buildSourceLink(node) {
    const path = node.relative_path;
    if (!path) return null;

    const line = node.start_line;
    const lineFragment = line ? `#L${line}` : "";

    for (const [prefix, rewrite] of Object.entries(SYMLINK_REWRITES)) {
        if (path.startsWith(prefix)) {
            return `${rewrite.base_url}/blob/${rewrite.branch}/${path}${lineFragment}`;
        }
    }

    const baseUrl = graphMetadata.github_url || "";
    if (!baseUrl) return null;
    return `${baseUrl}/blob/main/${path}${lineFragment}`;
}

function buildGraphLink(node) {
    const name = node.display_name || node.id || "";
    return `./index.html?source=${encodeURIComponent(name)}&sink=${encodeURIComponent(name)}`;
}

function updateFooter() {
    const link = document.getElementById("footerLink");
    const meta = document.getElementById("footerMeta");

    if (graphMetadata.github_url) {
        link.href = graphMetadata.github_url;
        link.textContent = graphMetadata.github_url.replace("https://github.com/", "");
    }

    const parts = [];
    if (graphMetadata.total_nodes) parts.push(`${graphMetadata.total_nodes} total nodes`);
    if (graphMetadata.total_edges) parts.push(`${graphMetadata.total_edges} edges`);
    if (graphMetadata.generated_at) {
        const d = new Date(graphMetadata.generated_at);
        if (!isNaN(d.getTime())) {
            parts.push(`generated ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`);
        }
    }
    meta.textContent = parts.join(" · ");
}

function escapeHtml(str) {
    if (!str) return "";
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
}

function escapeAttr(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
