import { readFile } from "node:fs/promises";
import { listSkills, listSlashCommands } from "./sdk-client.js";
/** Strip a slash-command name to the host's `/^[a-z][a-z0-9_-]*$/` shape. */
function sanitizeCommandName(name) {
    const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 64);
    return cleaned === "" ? "omp-command" : cleaned;
}
/**
 * Mount OMP discovery on the host seams. Fail-open: a missing `skills` or
 * `commands` service leaves the feature dormant, never blocks host boot.
 *
 * @param ctx - host plugin context.
 */
export function installOmpDiscovery(ctx) {
    // Skills: a discovery provider whose `list(cwd)` scans OMP's store for the
    // caller's workspace; the body is read lazily from SKILL.md in `get`.
    ctx.inject(["skills"], (scoped) => {
        const skills = scoped.get("skills");
        if (skills === undefined)
            return;
        skills.registerProvider(() => ({
            name: "omp",
            list: async (options) => {
                const found = await listSkills(options.cwd);
                return found.map((skill, rank) => ({
                    name: skill.name,
                    description: skill.description,
                    rank,
                    locator: skill.filePath,
                    path: skill.filePath,
                    invocation: { modelInvocable: true, userInvocable: true },
                    source: "custom",
                    provider: "omp",
                }));
            },
            get: async (candidate) => {
                const content = await readFile(String(candidate.locator), "utf8").catch(() => "");
                return {
                    name: candidate.name,
                    description: candidate.description,
                    content,
                    invocation: { modelInvocable: true, userInvocable: true },
                    source: "custom",
                    provider: "omp",
                };
            },
        }));
    });
    // Slash commands: register OMP's commands once at boot (default-workspace
    // discovery). The handler echoes the command body as the result text — a
    // first-pass surface; a deeper integration would route execution through the
    // bridged Agent.
    ctx.inject(["commands"], (scoped) => {
        const commands = scoped.get("commands");
        if (commands === undefined)
            return;
        void listSlashCommands().then((found) => {
            for (const command of found) {
                commands.register({
                    name: sanitizeCommandName(command.name),
                    description: command.description,
                    handler: () => ({ kind: "success", text: command.content }),
                });
            }
        });
    });
}
