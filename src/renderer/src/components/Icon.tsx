import type { ReactNode } from 'react'

const ICONS: Record<string, ReactNode> = {
  fetch: (
    <>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.7-3.5" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.7 3.5" />
      <path d="M12.5 1.5v3h-3" />
      <path d="M3.5 14.5v-3h3" />
    </>
  ),
  pull: (
    <>
      <path d="M8 2v9" />
      <path d="M4.5 7.5 8 11l3.5-3.5" />
      <path d="M3 14h10" />
    </>
  ),
  push: (
    <>
      <path d="M8 14V5" />
      <path d="M4.5 8.5 8 5l3.5 3.5" />
      <path d="M3 2h10" />
    </>
  ),
  branch: (
    <>
      <circle cx="5" cy="3.5" r="1.6" />
      <circle cx="5" cy="12.5" r="1.6" />
      <circle cx="11" cy="5" r="1.6" />
      <path d="M5 5.1v5.8" />
      <path d="M11 6.6c0 3-6 2.2-6 4.3" />
    </>
  ),
  stash: (
    <>
      <path d="M2 6.5h12v7H2z" />
      <path d="M2 6.5 4 3h8l2 3.5" />
      <path d="M6 9.5h4" />
    </>
  ),
  pop: (
    <>
      <path d="M2 9h12v5H2z" />
      <path d="M8 1.5v6" />
      <path d="M5.5 4 8 1.5 10.5 4" />
    </>
  ),
  terminal: (
    <>
      <path d="M2 3h12v10H2z" />
      <path d="m4.5 6 2 2-2 2" />
      <path d="M8 10h3.5" />
    </>
  ),
  folder: <path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z" />,
  close: (
    <>
      <path d="m4 4 8 8" />
      <path d="m12 4-8 8" />
    </>
  ),
  check: <path d="m3 8.5 3 3 7-7" />,
  laptop: (
    <>
      <path d="M3 3.5h10v6.5H3z" />
      <path d="M1.5 12.5h13" />
    </>
  ),
  cloud: <path d="M4.5 12.5h7.2a2.6 2.6 0 0 0 .2-5.2 3.6 3.6 0 0 0-6.9-.9 3 3 0 0 0-.5 6.1z" />,
  tag: (
    <>
      <path d="M1.8 2.2v5l6.8 6.8 5-5-6.8-6.8z" />
      <circle cx="4.7" cy="4.9" r="1" />
    </>
  ),
  chevronDown: <path d="m4 6 4 4 4-4" />,
  chevronRight: <path d="m6 4 4 4-4 4" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </>
  ),
  plus: (
    <>
      <path d="M8 3v10" />
      <path d="M3 8h10" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="m4 4 .8 9.5h6.4L12 4" />
    </>
  ),
  copy: (
    <>
      <path d="M5.5 5.5h8v8h-8z" />
      <path d="M3 10.5H2.5v-8h8V3" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 3v3.5H9.5" />
      <path d="M12.6 6.5A5 5 0 1 0 13 9" />
    </>
  ),
  repo: (
    <>
      <path d="M3.5 13.5v-11a1 1 0 0 1 1-1h8v10h-8a1 1 0 0 0-1 1 1 1 0 0 0 1 1h8" />
    </>
  ),
  stashItem: (
    <>
      <path d="M2.5 5.5h11v8h-11z" />
      <path d="M5.5 8.5h5" />
    </>
  ),
  pr: (
    <>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8" />
      <path d="M12 10.9V6.5a2 2 0 0 0-2-2H7.5" />
      <path d="M9 3 7.5 4.5 9 6" />
    </>
  ),
  merge: (
    <>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="9" r="1.6" />
      <path d="M4 5.1v5.8" />
      <path d="M4 5.1c0 2.6 3.2 3.9 6.4 3.9" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="3.2" fill="currentColor" />,
  minus: <path d="M3.5 8h9" />,
  comment: <path d="M2.5 3h11v7.5h-6l-3 2.5v-2.5h-2z" />,
  diffIcon: (
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M8 4.5v4M6 6.5h4M6 11h4" />
    </>
  ),
  edit: <path d="M10.5 2.5l3 3-7.5 7.5H3v-3z" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  external: (
    <>
      <path d="M9 2.5h4.5V7" />
      <path d="M13.5 2.5 7.5 8.5" />
      <path d="M12 9.5v4H2.5V4h4" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.5h5l3.5 3.5v9.5H4z" />
      <path d="M9 1.5V5h3.5" />
    </>
  ),
  warning: (
    <>
      <path d="M8 1.8 14.5 13.5h-13z" />
      <path d="M8 6v3.5" />
      <path d="M8 11.5v.2" />
    </>
  )
}

export function Icon({ name, size = 14, className }: { name: keyof typeof ICONS | string; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  )
}
