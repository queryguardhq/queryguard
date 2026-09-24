"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const reporter_1 = require("./reporter");
const BOT_MARKER = '<!-- queryguard:blast-radius-report -->';
function getParam(flag, actionInputKey, fallback) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && process.argv[idx + 1]) {
        return process.argv[idx + 1];
    }
    const envKey = `INPUT_${actionInputKey.toUpperCase().replace(/-/g, '_')}`;
    return process.env[envKey] || fallback;
}
function resolveConfig() {
    return {
        schemaPath: getParam('--schema', 'schema-path', 'test/schema.sql'),
        queriesPath: getParam('--queries', 'queries-path', 'test/queries.sql'),
        pgHost: process.env.PG_HOST || getParam('--host', 'pg-host', 'localhost'),
        pgPort: parseInt(process.env.PG_PORT || getParam('--port', 'pg-port', '5432'), 10),
        pgUser: process.env.PG_USER || getParam('--user', 'pg-user', 'postgres'),
        pgPass: process.env.PG_PASSWORD || getParam('--password', 'pg-password', 'postgres'),
        pgDb: process.env.PG_DATABASE || getParam('--database', 'pg-database', 'postgres'),
        mockRows: parseInt(process.env.MOCK_ROWS || getParam('--mock-rows', 'mock-rows', '500000'), 10),
        failOnSev1: (process.env.FAIL_ON_SEV1 || getParam('--fail-on-sev1', 'fail-on-sev1', 'false')) === 'true',
        githubToken: process.env.GITHUB_TOKEN || getParam('--token', 'github-token', ''),
    };
}
function extractColumn(filterClause) {
    if (!filterClause)
        return null;
    const match = filterClause.match(/\(?([a-zA-Z_0-9]+)\s*(=|>|<|>=|<=|~~|LIKE|IN)/i);
    return match ? match[1] : null;
}
async function upsertGithubComment(token, report) {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !fs.existsSync(eventPath)) {
        console.log('[QueryGuard] GITHUB_EVENT_PATH missing; skipping comment.');
        return;
    }
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    const prNumber = eventData.pull_request?.number;
    const repository = process.env.GITHUB_REPOSITORY;
    if (!prNumber || !repository) {
        console.log(`[QueryGuard] Non-PR context (PR: ${prNumber}, Repo:${repository}); skipping comment.`);
        return;
    }
    const commentsUrl = `https://api.github.com/repos/${repository}/issues/${prNumber}/comments`;
    const bodyWithMarker = `${BOT_MARKER}\n${report}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'QueryGuard-CI',
    };
    try {
        console.log(`[QueryGuard] Fetching existing PR comments from ${commentsUrl}...`);
        const listRes = await fetch(commentsUrl, { headers });
        if (!listRes.ok) {
            console.warn(`[QueryGuard] Could not list comments (Status ${listRes.status}). Posting new comment...`);
            await fetch(commentsUrl, { method: 'POST', headers, body: JSON.stringify({ body: bodyWithMarker }) });
            return;
        }
        const comments = await listRes.json();
        const existingComment = Array.isArray(comments)
            ? comments.find((c) => c.body && c.body.includes(BOT_MARKER))
            : null;
        if (existingComment) {
            console.log(`[QueryGuard] Found existing report comment (ID: ${existingComment.id}). Updating in place...`);
            const updateUrl = `https://api.github.com/repos/${repository}/issues/comments/${existingComment.id}`;
            const patchRes = await fetch(updateUrl, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ body: bodyWithMarker }),
            });
            if (patchRes.ok) {
                console.log('[QueryGuard] In-place PR comment successfully updated.');
            }
            else {
                const err = await patchRes.text();
                console.error(`[QueryGuard] Failed updating comment: ${err}`);
            }
        }
        else {
            console.log(`[QueryGuard] No prior comment with marker found. Creating new comment...`);
            const postRes = await fetch(commentsUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ body: bodyWithMarker }),
            });
            if (postRes.ok) {
                console.log('[QueryGuard] Successfully created initial PR comment.');
            }
            else {
                const err = await postRes.text();
                console.error(`[QueryGuard] Failed posting comment: ${err}`);
            }
        }
    }
    catch (err) {
        console.error(`[QueryGuard] API error during comment upsert: ${err.message}`);
    }
}
async function run() {
    const config = resolveConfig();
    const client = new pg_1.Client({
        host: config.pgHost,
        port: config.pgPort,
        user: config.pgUser,
        password: config.pgPass,
        database: config.pgDb,
    });
    console.log(`[QueryGuard] Connecting to database at ${config.pgHost}:${config.pgPort}/${config.pgDb}...`);
    await client.connect();
    try {
        const resolvedSchema = path.resolve(config.schemaPath);
        console.log(`[QueryGuard] Applying schema: ${resolvedSchema}`);
        const ddl = fs.readFileSync(resolvedSchema, 'utf8');
        await client.query(ddl);
        const resolvedQueries = path.resolve(config.queriesPath);
        console.log(`[QueryGuard] Evaluating queries: ${resolvedQueries}`);
        const rawSql = fs.readFileSync(resolvedQueries, 'utf8');
        // Strip single-line comments line-by-line so multi-line queries are preserved
        const sanitizedSql = rawSql
            .split('\n')
            .filter(line => !line.trim().startsWith('--'))
            .join('\n');
        const queryStatements = sanitizedSql
            .split(';')
            .map(q => q.trim())
            .filter(q => q.length > 0);
        console.log(`[QueryGuard] Parsed ${queryStatements.length} executable SQL statement(s).`);
        const findings = [];
        for (const sql of queryStatements) {
            try {
                const res = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`);
                const plan = res.rows[0]['QUERY PLAN'][0];
                const seqScanNodes = [];
                function walkPlan(node) {
                    if (node['Node Type'] === 'Seq Scan' && (node['Filter'] || node['Plan Rows'] > 1000)) {
                        seqScanNodes.push(node);
                    }
                    if (node.Plans) {
                        node.Plans.forEach(walkPlan);
                    }
                }
                walkPlan(plan.Plan);
                if (seqScanNodes.length === 0) {
                    findings.push({
                        query: sql,
                        totalCost: plan.Plan['Total Cost'],
                        hasSeqScan: false,
                    });
                }
                else {
                    for (const node of seqScanNodes) {
                        const table = node['Relation Name'] || 'unknown';
                        const col = extractColumn(node['Filter']);
                        const indexSql = col
                            ? `CREATE INDEX CONCURRENTLY idx_${table}_${col} ON ${table}(${col});`
                            : `CREATE INDEX CONCURRENTLY idx_${table}_scan ON${table}(/* columns */);`;
                        findings.push({
                            query: sql,
                            totalCost: plan.Plan['Total Cost'],
                            hasSeqScan: true,
                            targetTable: table,
                            impactedRows: node['Plan Rows'],
                            filterClause: node['Filter'],
                            recommendation: indexSql,
                        });
                    }
                }
            }
            catch (err) {
                console.warn(`[QueryGuard] Warning: Query execution error on "${sql}": ${err.message}`);
            }
        }
        const reportMarkdown = (0, reporter_1.buildMarkdownReport)(findings);
        fs.writeFileSync('queryguard-report.md', reportMarkdown);
        console.log('\n' + reportMarkdown);
        // Upsert the comment before exiting
        if (config.githubToken) {
            await upsertGithubComment(config.githubToken, reportMarkdown);
        }
        // Block merge if critical sequential scans are present
        const severeCount = findings.filter(f => f.hasSeqScan).length;
        if (severeCount > 0 && config.failOnSev1) {
            console.error(`\n[QueryGuard] CI GATING FAILURE: Detected ${severeCount} unindexed query pattern(s) with critical blast-radius.`);
            process.exit(1);
        }
    }
    finally {
        await client.end();
    }
}
run().catch(err => {
    console.error(`[QueryGuard] Fatal execution error: ${err.message}`);
    process.exit(1);
});
