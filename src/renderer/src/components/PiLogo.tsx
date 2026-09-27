export function PiLogo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <path
        d="M4.5 7.2c0-.9.7-1.6 1.6-1.6h11.8c.9 0 1.6.7 1.6 1.6s-.7 1.6-1.6 1.6h-2.1l-1.4 9.2c-.2 1-.7 1.4-1.3 1.4-.8 0-1.5-.7-1.3-1.8l1.3-8.8h-2.3l-1.4 9.2c-.2 1-.7 1.4-1.3 1.4-.8 0-1.5-.7-1.3-1.8l1.3-8.8H6.1c-.9 0-1.6-.7-1.6-1.6Z"
        fill="var(--accent)"
      />
    </svg>
  )
}
