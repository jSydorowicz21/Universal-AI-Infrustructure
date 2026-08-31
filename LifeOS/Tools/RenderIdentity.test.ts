import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderIdentity } from "./RenderIdentity";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function identityConfig(daName: string, fullName: string, mainVoice: string, algorithmVoice: string): string {
  return `[principal]
name = "Ada"
full_name = "Ada Lovelace"

[da]
name = "${daName}"
full_name = "${fullName}"

[da.voices.main]
voice_id = "${mainVoice}"

[da.voices.algorithm]
voice_id = "${algorithmVoice}"
`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("identity rendering", () => {
  test("renders only payload-owned targets from canonical config and supports safe rerendering", () => {
    const home = tempRoot("lifeos-render-identity-");
    const configRoot = join(home, ".claude");
    const dataRoot = join(home, ".pai");
    const userRoot = join(dataRoot, "USER");
    const templateRoot = join(home, "payload");
    mkdirSync(join(configRoot, "LIFEOS"), { recursive: true });
    mkdirSync(join(configRoot, "hooks"), { recursive: true });
    mkdirSync(join(templateRoot, "hooks"), { recursive: true });
    mkdirSync(join(templateRoot, "skills", "LifeOS", "Tools"), { recursive: true });
    mkdirSync(join(configRoot, "skills", "foreign"), { recursive: true });
    mkdirSync(join(configRoot, "skills", "LifeOS", "Tools"), { recursive: true });
    mkdirSync(join(userRoot, "CONFIG"), { recursive: true });
    mkdirSync(join(userRoot, "DIGITAL_ASSISTANT"), { recursive: true });
    mkdirSync(join(userRoot, "PRINCIPAL"), { recursive: true });
    writeFileSync(join(configRoot, "LIFEOS", "VERSION"), "7.40.4\n");
    writeFileSync(join(configRoot, "settings.json"), JSON.stringify({
      daidentity: {
        name: "Stale Settings",
        fullName: "Stale Settings Assistant",
        voices: {
          main: { voiceId: "stale-main" },
          algorithm: { voiceId: "stale-algorithm" },
        },
      },
    }));
    writeFileSync(join(userRoot, "CONFIG", "LIFEOS_CONFIG.toml"), identityConfig("Nova", "Nova Assistant", "nova-main", "nova-algorithm"));
    writeFileSync(join(userRoot, "DIGITAL_ASSISTANT", "DA_IDENTITY.md"), "# DA Identity — Markdown Fallback\n");
    writeFileSync(join(userRoot, "PRINCIPAL", "PRINCIPAL_IDENTITY.md"), "# Principal Identity — Markdown User\n\n- **Name:** Markdown User\n");

    const ownedFile = join(configRoot, "hooks", "ConfigEvalFire.hook.ts");
    const foreignSkill = join(configRoot, "skills", "foreign", "SKILL.md");
    const rendererControl = join(configRoot, "skills", "LifeOS", "Tools", "RenderIdentity.ts");
    const sourceTemplate = "console.log('{{DA_NAME}} behavioural');\n";
    writeFileSync(join(templateRoot, "hooks", "ConfigEvalFire.hook.ts"), sourceTemplate);
    writeFileSync(join(templateRoot, "skills", "LifeOS", "Tools", "RenderIdentity.ts"), "const token = '{{DA_NAME}}';\n");
    writeFileSync(ownedFile, sourceTemplate);
    writeFileSync(foreignSkill, "{{DA_NAME}}\n");
    writeFileSync(rendererControl, "const token = '{{DA_NAME}}';\n");
    const preview = renderIdentity({ configRoot, dataRoot, apply: false, templateRoot });
    expect(preview).toMatchObject({ ok: true, dryRun: true, substitution: { modified: 1, applied: 0 } });
    expect(preview.verification).toMatchObject({ passed: true, total: 0 });
    expect(readFileSync(ownedFile, "utf8")).toContain("{{DA_NAME}}");
    expect(existsSync(join(configRoot, ".uai-identity-render.json"))).toBe(false);

    const result = renderIdentity({ configRoot, dataRoot, apply: true, templateRoot });

    expect(result.ok).toBe(true);
    expect(result.verification).toMatchObject({ passed: true, total: 0 });
    expect(result.variables).toMatchObject({
      "{{DA_NAME}}": "Nova",
      "{{DA_FULL_NAME}}": "Nova Assistant",
      "{{PRINCIPAL_NAME}}": "Ada",
      "{{PRINCIPAL_FULL_NAME}}": "Ada Lovelace",
      "{{PRIMARY_VOICE_ID}}": "nova-main",
      "{{SECONDARY_VOICE_ID}}": "nova-algorithm",
    });
    expect(readFileSync(ownedFile, "utf8")).toContain("Nova behavioural");
    expect(readFileSync(ownedFile, "utf8")).not.toContain("{{DA_NAME}}");
    expect(readFileSync(foreignSkill, "utf8")).toBe("{{DA_NAME}}\n");
    expect(readFileSync(rendererControl, "utf8")).toBe("const token = '{{DA_NAME}}';\n");
    expect(existsSync(join(configRoot, ".uai-identity-render.json"))).toBe(true);
    const cachedTemplate = join(configRoot, ".uai-identity-templates", "hooks", "ConfigEvalFire.hook.ts");
    expect(readFileSync(cachedTemplate, "utf8")).toBe(sourceTemplate);

    writeFileSync(join(userRoot, "CONFIG", "LIFEOS_CONFIG.toml"), identityConfig("Echo", "Echo Assistant", "echo-main", "echo-algorithm"));
    const rerendered = renderIdentity({ configRoot, dataRoot, apply: true, templateRoot: join(home, "missing-payload") });

    expect(rerendered.ok).toBe(true);
    expect(rerendered.substitution).toMatchObject({ modified: 1, applied: 1 });
    expect(readFileSync(ownedFile, "utf8")).toContain("Echo behavioural");
    expect(readFileSync(ownedFile, "utf8")).not.toContain("Nova behavioural");
    expect(readFileSync(foreignSkill, "utf8")).toBe("{{DA_NAME}}\n");
  }, 15_000);
  test("ignores untouched bootstrap config values in favor of identity files", () => {
    const home = tempRoot("lifeos-render-bootstrap-");
    const configRoot = join(home, ".claude");
    const dataRoot = join(home, ".pai");
    const userRoot = join(dataRoot, "USER");
    mkdirSync(join(configRoot, "LIFEOS"), { recursive: true });
    mkdirSync(join(configRoot, "hooks"), { recursive: true });
    mkdirSync(join(userRoot, "CONFIG"), { recursive: true });
    mkdirSync(join(userRoot, "DIGITAL_ASSISTANT"), { recursive: true });
    mkdirSync(join(userRoot, "PRINCIPAL"), { recursive: true });
    writeFileSync(join(configRoot, "LIFEOS", "VERSION"), "7.40.4\n");
    writeFileSync(join(configRoot, "settings.json"), JSON.stringify({ daidentity: { name: "Stale Settings", fullName: "Stale Assistant" } }));
    writeFileSync(join(userRoot, "CONFIG", "LIFEOS_CONFIG.toml"), "# Bootstrap default\n[principal]\nname = \"Your Name\"\n[da]\nname = \"Aria\"\n");
    writeFileSync(join(userRoot, "DIGITAL_ASSISTANT", "DA_IDENTITY.md"), "# DA Identity — PAI\n\n- **Name:** PAI | **Full Name:** PAI\n- **Voice (main):** \u0060main-voice\u0060 (Main)\n- **Voice (algorithm):** \u0060algorithm-voice\u0060 (Algorithm)\n");
    writeFileSync(join(userRoot, "PRINCIPAL", "PRINCIPAL_IDENTITY.md"), "# Principal Identity — User\n\n- **Name:** User\n");
    const ownedFile = join(configRoot, "hooks", "ConfigEvalFire.hook.ts");
    writeFileSync(ownedFile, readFileSync(join(import.meta.dir, "..", "install", "hooks", "ConfigEvalFire.hook.ts"), "utf8"));

    const result = renderIdentity({ configRoot, dataRoot, apply: true });

    expect(result.variables).toMatchObject({
      "{{DA_NAME}}": "PAI",
      "{{DA_FULL_NAME}}": "PAI",
      "{{PRINCIPAL_NAME}}": "User",
      "{{PRIMARY_VOICE_ID}}": "main-voice",
      "{{SECONDARY_VOICE_ID}}": "algorithm-voice",
    });
    expect(result.verification).toMatchObject({ passed: true, total: 0 });
  });

  test("refuses to mutate a source checkout unless explicitly allowed", () => {
    const configRoot = tempRoot("lifeos-render-dev-tree-");
    const dataRoot = join(configRoot, ".pai");
    mkdirSync(join(configRoot, ".git"), { recursive: true });
    mkdirSync(join(configRoot, "LifeOS", "install"), { recursive: true });
    mkdirSync(join(configRoot, "LifeOS", "Tools"), { recursive: true });
    mkdirSync(join(configRoot, "hooks"), { recursive: true });
    writeFileSync(join(configRoot, "LifeOS", "Tools", "InstallEngine.ts"), "export {};\n");
    const target = join(configRoot, "hooks", "ConfigEvalFire.hook.ts");
    const sourceTemplate = readFileSync(join(import.meta.dir, "..", "install", "hooks", "ConfigEvalFire.hook.ts"), "utf8");
    writeFileSync(target, sourceTemplate);

    const result = renderIdentity({ configRoot, dataRoot, apply: true });

    expect(result).toMatchObject({ ok: false, refused: "dev-tree" });
    expect(readFileSync(target, "utf8")).toBe(sourceTemplate);
  });
});
