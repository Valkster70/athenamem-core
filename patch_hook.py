#!/usr/bin/env python3
f = '/home/chris/.openclaw/extensions/athenamem-core/dist/index.js'
c = open(f).read()

# Fix: Replace autoRecallRan flag with time-based check (run at most once per 30 min)
old = "let autoRecallRan = false;"
new = "let autoRecallRanAt = 0;"

old2 = """            if (autoRecallRan)
                return;
            autoRecallRan = true;
            try {
                const contextHint = event.rawMessage || "";
                const bootResult = await onAgentBoot(contextHint);
                const sections = [bootResult.l0_l1_summary];
                if (bootResult.auto_recall?.results.length) {
                    sections.push("## Recalled Memories");
                    for (const result of bootResult.auto_recall.results.slice(0, 5)) {
                        const content = result.content || result.id || "memory";
                        sections.push(`- [${result.source}] ${String(content).substring(0, 100)}${String(content).length > 100 ? "..." : ""}`);
                    }
                }
                const systemContext = `<athenamem_context>\\n${sections.join("\\n\\n")}\\n</athenamem_context>`;
                console.log(`[AthenaMem Core] Boot: ${bootResult.auto_recall?.results.length ?? 0} recalled, injecting context`);
                // Return context injection — runtime may accept this even if TS type says void
                return { prependSystemContext: systemContext };
            }
            catch (err) {
                console.error("[AthenaMem Core] Boot failed:", err);
            }"""

new2 = """            const now = Date.now();
            // Run once per 30 min max (to cover fresh sessions while allowing recovery)
            if (now - autoRecallRanAt < 30 * 60 * 1000)
                return;
            autoRecallRanAt = now;
            try {
                const contextHint = event.rawMessage || "";
                const bootResult = await onAgentBoot(contextHint);
                const sections = [bootResult.l0_l1_summary];
                if (bootResult.auto_recall?.results.length) {
                    sections.push("## Recalled Memories");
                    for (const result of bootResult.auto_recall.results.slice(0, 5)) {
                        const content = result.content || result.id || "memory";
                        sections.push(`- [${result.source}] ${String(content).substring(0, 100)}${String(content).length > 100 ? "..." : ""}`);
                    }
                }
                const systemContext = `<athenamem_context>\\n${sections.join("\\n\\n")}\\n</athenamem_context>`;
                console.log(`[AthenaMem Core] Boot: ${bootResult.auto_recall?.results.length ?? 0} recalled, injecting context`);
                return { prependSystemContext: systemContext };
            }
            catch (err) {
                console.error("[AthenaMem Core] Boot failed:", err);
            }"""

if old in c:
    c = c.replace(old, new, 1)
    print('Flag replaced')
else:
    print('Flag not found')

if old2 in c:
    c = c.replace(old2, new2, 1)
    print('Hook body replaced')
else:
    print('Hook body not found')

open(f, 'w').write(c)
