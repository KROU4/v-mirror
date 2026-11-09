// Единый набор пиктограмм: штрих 2px, скруглённые концы, сетка 24.
import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p,
});

export const IconScan = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <circle cx="12" cy="11" r="3" />
    <path d="M7.5 17.5c1.2-1.6 2.7-2.4 4.5-2.4s3.3.8 4.5 2.4" />
  </svg>
);
export const IconShuffle = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M16 4h4v4M20 4l-6.5 6.5M4 20l6-6M16 20h4v-4M20 20 4 4" />
  </svg>
);
export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
  </svg>
);
export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </svg>
);
export const IconLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m15 5-7 7 7 7" />
  </svg>
);
export const IconRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m9 5 7 7-7 7" />
  </svg>
);
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 3, ...p })}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
export const IconUpload = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </svg>
);
export const IconBack = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);
export const IconReset = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6" />
    <path d="M4 4v4.6h4.6" />
  </svg>
);
/** Контурный треугольник, как стрелки строк в редакторе игры */
export const IconTriLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 1.6, ...p })}>
    <path d="M17 4.5v15L5.5 12z" />
  </svg>
);
export const IconTriRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 1.6, ...p })}>
    <path d="M7 4.5v15L18.5 12z" />
  </svg>
);
export const IconGrid = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 1.6, ...p })}>
    {[4, 10, 16].flatMap((y) => [4, 10, 16].map((x) => <rect key={`${x}${y}`} x={x} y={y} width="4" height="4" />))}
  </svg>
);
/** Стрелка клавиши: в шрифте Tektur нет символов ← ↑ → ↓ */
export const IconArrow = ({ dir, ...p }: SVGProps<SVGSVGElement> & { dir: 'up' | 'down' | 'left' | 'right' }) => (
  <svg {...base({ strokeWidth: 2.4, ...p })} style={{ transform: `rotate(${{ up: 0, right: 90, down: 180, left: 270 }[dir]}deg)` }}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
export const IconClose =(p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const IconDownload = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 4v12M7 11l5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
);
