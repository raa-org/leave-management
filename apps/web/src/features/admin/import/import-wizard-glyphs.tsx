/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/**
 * Stroke-outline glyphs for the import wizard, traced from the prototype
 * (admin-import-rail.html). Same 24x24 / 1.7-1.8px stroke language as the
 * shared glyph set in employee-ui; the svg attributes are inlined here because
 * employee-ui's glyphProps helper is module-private (the ShieldGlyph in
 * policy-ui set the precedent).
 */

const svgProps = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  'aria-hidden': true as const,
  style: { display: 'block' as const },
})

/** Arrow up into a tray: the Import tab and the workbook dropzone. */
export function UploadGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M12 15V5m0 0L8.5 8.5M12 5l3.5 3.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Arrow down into a tray: the Export tab and its card. */
export function DownloadGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M12 4v9m0 0 3.5-3.5M12 13 8.5 9.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A document with text lines: the source file card. */
export function SourceFileGlyph({ size = 19 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M9 13h6M9 17h4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** A document with a check: the validation card. */
export function ValidationGlyph({ size = 19 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M9 12l2 2 4-4M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** An eye: the review card. */
export function ReviewGlyph({ size = 19 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

/** A circled check: the apply card. */
export function ApplyGlyph({ size = 19 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m8.5 12 2.5 2.5 4.5-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
