import { atomicFile, integer, optionalStat, readOptionalText, relativePath, requireThat, text } from './io.mjs';

export const LESSONS_FILE = 'leanloop.lessons.md';
export const MAX_LESSONS = 30;
export const MAX_LESSONS_BYTES = 8 * 1024;
const HEADER = [
  '# Project lessons',
  '',
  'Managed by LeanLoop (`learn`, `forget`). At most 30 lessons and 8 KiB.',
  'Keep each lesson short, still true, and backed by evidence. Replace stale ones.',
  '',
];
const ENTRY = /^- L(\d{1,4}) \((\d{4}-\d{2}-\d{2})\) (.+) \[evidence: (.+?)\](?: \[anchor: ([^\]]+)\])?$/;
// Near-duplicates differ only in case, spacing, or trailing punctuation.
const normalize = value => value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!;:,\s]+$/, '');

function field(value, label, limit) {
  const clean = text(value, label, limit);
  requireThat(!/[\r\n]/.test(clean) && !clean.includes('[evidence:') && !clean.includes('[anchor:'),
    `${label} must be one line without "[evidence:" or "[anchor:".`);
  return clean;
}

export function readLessons(root) {
  const stat = optionalStat(root, LESSONS_FILE);
  if (!stat) return [];
  requireThat(stat.isFile(), `${LESSONS_FILE} must be a regular file.`);
  requireThat(stat.size <= MAX_LESSONS_BYTES,
    `${LESSONS_FILE} exceeds its 8 KiB budget; curate it by hand.`, 'LESSONS_FULL');
  const lessons = [];
  const contents = readOptionalText(root, LESSONS_FILE, MAX_LESSONS_BYTES);
  requireThat(contents !== null, 'Lessons changed during reading; retry.', 'SOURCE_CHANGED');
  const lines = contents.split('\n');
  HEADER.forEach((line, index) => {
    requireThat(lines[index] === line, `${LESSONS_FILE} line ${index + 1} differs from the managed header. ` +
      'Move other text elsewhere so it is not lost.', 'CORRUPT_DATA');
  });
  lines.slice(HEADER.length).forEach((line, offset) => {
    if (!line.trim()) return;
    const match = ENTRY.exec(line);
    requireThat(match, `${LESSONS_FILE} line ${HEADER.length + offset + 1} is not a lesson entry. ` +
      'Move other text elsewhere so it is not lost.', 'CORRUPT_DATA');
    integer(Number(match[1]), 'Lesson ID', 1, 9999);
    field(match[3], 'Lesson', 300);
    field(match[4], 'Evidence', 200);
    if (match[5] !== undefined) relativePath(match[5], 'Lesson anchor');
    lessons.push({ id: Number(match[1]), date: match[2], text: match[3], evidence: match[4], ...(match[5] ? { anchor: match[5] } : {}) });
  });
  requireThat(lessons.length <= MAX_LESSONS,
    `${LESSONS_FILE} exceeds its ${MAX_LESSONS}-lesson budget; curate it by hand.`, 'LESSONS_FULL');
  requireThat(new Set(lessons.map(item => item.id)).size === lessons.length, `${LESSONS_FILE} has duplicate lesson IDs.`, 'CORRUPT_DATA');
  return lessons;
}

function render(lessons) {
  return `${[...HEADER, ...lessons.map(item => `- L${item.id} (${item.date}) ${item.text} [evidence: ${item.evidence}]` +
    (item.anchor ? ` [anchor: ${item.anchor}]` : ''))].join('\n')}\n`;
}

function write(root, lessons) {
  const content = render(lessons);
  const bytes = Buffer.byteLength(content);
  requireThat(lessons.length <= MAX_LESSONS && bytes <= MAX_LESSONS_BYTES,
    `Lessons are full (${MAX_LESSONS} entries or 8 KiB). Replace or forget a stale lesson first; do not grow memory without limit.`, 'LESSONS_FULL');
  atomicFile(root, LESSONS_FILE, content, { mode: 0o644 });
  return bytes;
}

// Lessons are hints: an anchor that no longer exists marks a lesson to re-verify or forget.
export function listLessons(root) {
  const lessons = readLessons(root).map(item => (item.anchor ? { ...item, stale: optionalStat(root, item.anchor) === null } : item));
  return {
    ok: true, file: LESSONS_FILE, count: lessons.length, limit: MAX_LESSONS,
    bytes: optionalStat(root, LESSONS_FILE)?.size ?? 0,
    maxBytes: MAX_LESSONS_BYTES, stale: lessons.filter(item => item.stale).map(item => item.id), lessons,
  };
}

export function learn(root, lesson, evidence, replace, anchor) {
  const clean = field(lesson, 'Lesson', 300);
  const proof = field(evidence, 'Evidence', 200);
  if (anchor !== undefined) {
    relativePath(anchor, 'Lesson anchor');
    requireThat(!anchor.includes(']') && optionalStat(root, anchor) !== null, `Lesson anchor does not exist: ${anchor}`);
  }
  const lessons = readLessons(root);
  const date = new Date().toISOString().slice(0, 10);
  let entry;
  if (replace !== undefined) {
    integer(replace, 'Lesson ID', 1, 9999);
    entry = lessons.find(item => item.id === replace);
    requireThat(entry, `No lesson L${replace}.`);
    Object.assign(entry, { date, text: clean, evidence: proof });
    if (anchor !== undefined) entry.anchor = anchor;
    else delete entry.anchor;
  } else {
    const duplicate = lessons.find(item => normalize(item.text) === normalize(clean));
    requireThat(!duplicate, `This lesson already exists as L${duplicate?.id}; replace it instead of adding a copy.`);
    entry = { id: Math.max(0, ...lessons.map(item => item.id)) + 1, date, text: clean, evidence: proof, ...(anchor ? { anchor } : {}) };
    requireThat(entry.id <= 9999, 'Lesson IDs are exhausted; renumber the file by hand.');
    lessons.push(entry);
  }
  const bytes = write(root, lessons);
  return { ok: true, file: LESSONS_FILE, lesson: entry, count: lessons.length, limit: MAX_LESSONS, bytes, maxBytes: MAX_LESSONS_BYTES };
}

export function forget(root, id) {
  integer(id, 'Lesson ID', 1, 9999);
  const lessons = readLessons(root);
  const remaining = lessons.filter(item => item.id !== id);
  requireThat(remaining.length < lessons.length, `No lesson L${id}.`);
  const bytes = write(root, remaining);
  return { ok: true, file: LESSONS_FILE, removed: id, count: remaining.length, limit: MAX_LESSONS, bytes };
}
