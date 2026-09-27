/**
 * The official pi mark (three shapes: coral, blue, amber) from
 * https://pi.dev/logo.svg — the logo belongs to Earendil / the pi project
 * and is used here to identify pi. viewBox is cropped to the mark bounds.
 */
export function PiLogo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="165.29 165.29 469.43 469.43"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
      <path
        fill="#4D9ABF"
        d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"
      />
      <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  )
}
