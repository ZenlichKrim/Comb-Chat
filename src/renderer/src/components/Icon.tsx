import React from 'react'

export type IconName =
  | 'code'
  | 'braces'
  | 'image'
  | 'plus'
  | 'minus'
  | 'close'
  | 'check'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-left'
  | 'arrow-up'
  | 'arrow-right'
  | 'arrow-left'
  | 'square'
  | 'stop'
  | 'play'
  | 'folder'
  | 'file'
  | 'file-plus'
  | 'paperclip'
  | 'search'
  | 'settings'
  | 'terminal'
  | 'git'
  | 'chat'
  | 'layers'
  | 'copy'
  | 'trash'
  | 'refresh'
  | 'sun'
  | 'moon'
  | 'cpu'
  | 'key'
  | 'eye'
  | 'eye-off'
  | 'edit'
  | 'external'
  | 'pin'
  | 'more'
  | 'undo'
  | 'redo'
  | 'save'
  | 'command'
  | 'sidebar'
  | 'panel-right'
  | 'panel-bottom'
  | 'zap'
  | 'shield'
  | 'clock'
  | 'wallet'
  | 'bell'
  | 'sticky'
  | 'alert'
  | 'info'
  | 'x-circle'
  | 'check-circle'
  | 'loader'
  | 'diff'
  | 'history'
  | 'sparkles'
  | 'bee'

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: IconName
  size?: number
  strokeWidth?: number
}

const paths: Record<IconName, React.ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3 8.5l3.2 3.2L13 5" />,
  'chevron-right': <path d="M6 3.5L10.5 8 6 12.5" />,
  'chevron-down': <path d="M3.5 6L8 10.5 12.5 6" />,
  'chevron-left': <path d="M10 3.5L5.5 8 10 12.5" />,
  'arrow-up': <path d="M8 13V3M4 7l4-4 4 4" />,
  'arrow-right': <path d="M3 8h10M9 4l4 4-4 4" />,
  'arrow-left': <path d="M13 8H3M7 4L3 8l4 4" />,
  square: <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
  play: <path d="M5 3.5l7 4.5-7 4.5z" />,
  folder: <path d="M2 4.5A1.5 1.5 0 013.5 3h2.6c.4 0 .8.2 1 .5l.9 1.2h4.5A1.5 1.5 0 0114 6.2v5.3A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5z" />,
  file: (
    <>
      <path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6z" />
      <path d="M9 2v4h4" />
    </>
  ),
  code: <path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5" />,
  braces: <path d="M6 2.5c-1.2 0-1.6.8-1.6 2v1c0 1-.6 1.8-1.4 2 .8.2 1.4 1 1.4 2v1c0 1.2.4 2 1.6 2M10 2.5c1.2 0 1.6.8 1.6 2v1c0 1 .6 1.8 1.4 2-.8.2-1.4 1-1.4 2v1c0 1.2-.4 2-1.6 2" />,
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1.1" />
      <path d="M3 11.5l3.2-3 2.4 2.2 1.8-1.6L13 11" />
    </>
  ),
  paperclip: (
    <>
      <path d="M13.5 7.5l-5.6 5.6a2.1 2.1 0 01-3-3l6-6a3.5 3.5 0 015 5l-6 6a5 5 0 01-7-7l5.5-5.5" />
    </>
  ),
  'file-plus': (
    <>
      <path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6z" />
      <path d="M9 2v4h4M8 8.5v3M6.5 10h3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4 6l2 2-2 2M8.5 10.5h3" />
    </>
  ),
  git: (
    <>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="6.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 8.1c0 2-1.5 2.4-3 2.8" />
    </>
  ),
  chat: <path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v6A1.5 1.5 0 0112.5 11H6l-3 2.5V11H3.5A1.5 1.5 0 012 9.5z" />,
  layers: (
    <>
      <path d="M8 1.8l6 3.2-6 3.2-6-3.2z" />
      <path d="M2 8.2l6 3.2 6-3.2M2 11.6l6 3.2 6-3.2" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5v-2A1.5 1.5 0 009 2H3.5A1.5 1.5 0 002 3.5V9a1.5 1.5 0 001.5 1.5h2" />
    </>
  ),
  trash: <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.1a1.2 1.2 0 001.2 1.1h4.2a1.2 1.2 0 001.2-1.1L12 4M6.5 7v4.5M9.5 7v4.5" />,
  refresh: <path d="M13.5 8a5.5 5.5 0 11-1.8-4.1M13.5 2v3.2h-3.2" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" />
    </>
  ),
  moon: <path d="M13.5 9.5A5.8 5.8 0 116.5 2.5a4.6 4.6 0 007 7z" />,
  cpu: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.2" />
      <path d="M6.5 1v2M9.5 1v2M6.5 13v2M9.5 13v2M1 6.5h2M1 9.5h2M13 6.5h2M13 9.5h2" />
    </>
  ),
  key: (
    <>
      <circle cx="5.5" cy="10.5" r="3" />
      <path d="M7.8 8.2L14 2M11 5l2 2" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S3.7 3.5 8 3.5 14.5 8 14.5 8 12.3 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M6.3 3.8A6.4 6.4 0 018 3.5C12.3 3.5 14.5 8 14.5 8a10 10 0 01-2 2.4M9.9 12.1a6.6 6.6 0 01-1.9.4C3.7 12.5 1.5 8 1.5 8a10.6 10.6 0 012.6-3" />
      <path d="M2 2l12 12" />
    </>
  ),
  edit: <path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5zM9.5 4l2.5 2.5" />,
  external: <path d="M6.5 3H3v10h10V9.5M9 2h5v5M14 2L7.5 8.5" />,
  pin: <path d="M9.5 1.5l5 5-2 1-3 3 .5 3.5-2-2-4.5 2.5 2.5-4.5-2-2L7.5 7l.5-2z" />,
  more: (
    <>
      <circle cx="3" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="13" cy="8" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  undo: <path d="M3 5.5h6.5a3.5 3.5 0 010 7H6M3 5.5L6 2.5M3 5.5l3 3" />,
  redo: <path d="M13 5.5H6.5a3.5 3.5 0 000 7H10M13 5.5L10 2.5M13 5.5l-3 3" />,
  save: (
    <>
      <path d="M2 3.5A1.5 1.5 0 013.5 2h7L14 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5z" />
      <path d="M5 2v3.5h5V2M4.5 9h7v4.5h-7z" />
    </>
  ),
  command: <path d="M5 3a2 2 0 100 4h6a2 2 0 100-4v10a2 2 0 10-0-4H5a2 2 0 100 4z" />,
  sidebar: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
    </>
  ),
  'panel-right': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
    </>
  ),
  'panel-bottom': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 9.5h13" />
    </>
  ),
  zap: <path d="M9 1.5L3 9.5h4l-1 5 6-8H8z" />,
  shield: <path d="M8 1.5l5.5 2v4c0 3.2-2.3 5.8-5.5 7-3.2-1.2-5.5-3.8-5.5-7v-4z" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  sticky: (
    <>
      <path d="M3.2 3.2h9.6v6.4l-3.2 3.2H3.2z" />
      <path d="M12.8 9.6H9.6v3.2" />
    </>
  ),
  wallet: (
    <>
      <rect x="2.2" y="4" width="11.6" height="8.4" rx="1.6" />
      <path d="M2.2 6.7h11.6" />
      <circle cx="10.4" cy="9.7" r="0.6" />
    </>
  ),
  bell: (
    <>
      <path d="M4.3 7a3.7 3.7 0 017.4 0c0 2.3.6 3.3 1.2 4H3.1c.6-.7 1.2-1.7 1.2-4z" />
      <path d="M6.6 12.7a1.5 1.5 0 002.8 0" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2L15 13.5H1z" />
      <path d="M8 6v3.5M8 11.6v.01" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4M8 4.8v.01" />
    </>
  ),
  'x-circle': (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5 8.2l2.2 2.2L11 6.5" />
    </>
  ),
  loader: <path d="M8 1.5a6.5 6.5 0 106.5 6.5" />,
  diff: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M8 2.5v11M4 6h1.5M3.3 6.8h1.5" />
    </>
  ),
  history: <path d="M13.5 8a5.5 5.5 0 10-5.5 5.5c1.6 0 3-.7 4-1.8M13.5 2.5v3h-3" />,
  sparkles: <path d="M6 1.5l1 3 3 1-3 1-1 3-1-3-3-1 3-1zM12 8l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />,
  bee: (
    <>
      <ellipse cx="8" cy="9.5" rx="4" ry="4.2" />
      <path d="M4.2 8h7.6M4.3 11h7.4M8 5.3V2M6.5 2.5L8 3.5l1.5-1" />
    </>
  )
}

export function Icon({ name, size = 14, strokeWidth = 1.5, className, style, ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: 'none', display: 'block', ...style }}
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}
