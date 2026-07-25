// No helpers defined yet. Note what repeats and how many times.

export const renderCarousel = ({ items, cursor, viewportRows, gridCols }) => {
  const prev = items[(((cursor - 1) % items.length) + items.length) % items.length];
  const next = items[(((cursor + 1) % items.length) + items.length) % items.length];
  const jump = items[(((cursor + gridCols) % items.length) + items.length) % items.length];

  const visible = items.length > 0 ? items.slice(0, viewportRows) : [];
  const footer = items.length > 0 ? 'showing results' : 'empty';
  const showPager = items.length > 0;

  return { prev, next, jump, visible, footer, showPager };
};
