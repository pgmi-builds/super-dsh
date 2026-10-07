/**
 * Build-time copy of repo docs into the package (`files: ["docs"]`).
 * Ships the public doc tree only — internal research, scratch notes,
 * foreign doc mirrors, uncited third-party reference material, and
 * bulky probe-evidence dumps stay out of the npm tarball; boot-token
 * literals in test reports are redacted in the copy (repo files untouched).
 *
 * Standing rule (.gitignore): docs/60_exploration-and-research is
 * "internal exploration & research (never publish)". superd/ and
 * dsh-sys-prompt_*.md are untracked internal notes that must not ship;
 * *_artifacts/ directories are local probe evidence (2.8MB), not docs.
 *
 * docs-packaging-trim (docs/specs/docs-packaging-trim/spec.md, 档位 F):
 * hermes-dev-skill (别家框架文档镜像，抓取后从未蒸馏)、dsh-dev-skill 的
 * pi-and-omp 第三方资料与 src-scripts 抓取工具，一律不进发布副本。
 * repo 的 docs/ 树一字不动——本脚本 rmSync/cpSync 只作用于包内副本。
 */
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname, resolve } from 'node:path';

/** Path fragments excluded from the shipped copy (matched against source path). */
export const EXCLUDE = [
  /(^|\/)60_exploration-and-research($|\/)/,
  /(^|\/)superd($|\/)/,
  /(^|\/)dsh-sys-prompt_[^/]*\.md$/,
  /(^|\/)[^/]*_artifacts($|\/)/,
  // docs-packaging-trim（docs/specs/docs-packaging-trim/spec.md，档位 F）：
  //   摘掉与 DSH / 本插件无关的材料。repo 的 docs/ 一字不动，只影响发布副本。
  /(^|\/)hermes-dev-skill($|\/)/, // 别家框架文档镜像；抓取阶段产物，无 SKILL.md
  /(^|\/)dsh-dev-skill\/pi-and-omp($|\/)/, // OMP/Pi 第三方资料；技能正文零引用
  /(^|\/)dsh-dev-skill\/src-scripts($|\/)/, // 抓取工具 + 3.5MB 构建清单
];

/** True when a repo-relative source path must NOT enter the published copy. */
export function excluded(srcPath) {
  return EXCLUDE.some((re) => re.test(srcPath));
}

/** Copy only the native/shared documentation explicitly selected by the monorepo. */
export function copyDocs(source, target) {
  const catalog = JSON.parse(readFileSync(join(source, 'package-catalog.json'), 'utf8'))['better-dsh'];
  if (!Array.isArray(catalog)) throw new Error('Better Dash documentation catalog is missing');
  const valid = file => typeof file === 'string' && file.length > 0 && !file.startsWith('/') && !file.split('/').some(part => part === '..' || part === '.' || part === '');
  const planned = catalog.map(entry => typeof entry === 'string' ? { source: entry, target: entry } : entry);
  const outputs = new Set();
  for (const entry of planned) {
    if (!valid(entry?.source) || !valid(entry?.target)) throw new Error('Invalid documentation catalog path');
    if (outputs.has(entry.target)) throw new Error('Duplicate documentation catalog target');
    outputs.add(entry.target);
  }
  const selected = planned.filter(entry => !excluded(`docs/${entry.source}`) && !excluded(`docs/${entry.target}`));
  // Validate every source before clearing the previous output.
  for (const entry of selected) readFileSync(join(source, entry.source));
  rmSync(target, { recursive: true, force: true });
  let redacted = 0;
  for (const entry of selected) {
    const output = join(target, entry.target);
    mkdirSync(dirname(output), { recursive: true });
    cpSync(join(source, entry.source), output);
    if (entry.target.endsWith('.md')) {
      const text = readFileSync(output, 'utf8');
      const clean = text.replace(/token=[A-Za-z0-9_-]{20,}/g, 'token=<redacted>');
      if (clean !== text) { writeFileSync(output, clean); redacted++; }
    }
  }
  return { files: selected.length, redacted };
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = copyDocs(resolve('../docs'), resolve('docs'));
  console.log(`copy-docs: ${result.files} selected native/shared files (${result.redacted} token-redacted)`);
}
