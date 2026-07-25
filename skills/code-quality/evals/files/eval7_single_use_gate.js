// Each of these is used EXACTLY ONCE in this file.

const isEligible = (user) => user.age >= 18;

const normalizeAngle = (deg) => {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
};

const hasItems = (rows) => rows.length > 0;

const parseContentRange = (header) => {
  const [, start, end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(header) ?? [];
  return { start: Number(start), end: Number(end), total: Number(total) };
};

const isPositive = (n) => n > 0;

export const run = (user, rows, deg, header, n) => {
  if (!isEligible(user)) return null;
  if (!hasItems(rows)) return null;
  if (!isPositive(n)) return null;
  return { angle: normalizeAngle(deg), range: parseContentRange(header) };
};
