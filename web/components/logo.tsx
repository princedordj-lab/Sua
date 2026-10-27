import Link from "next/link";
import Image from "next/image";

export function Logo({
  href = "/",
  compact = false,
  className = "",
}: {
  href?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link href={href} className={`wordmark app-wordmark ${className}`} aria-label="Sua home">
      <span className="brand-mark" aria-hidden="true">
        <Image
          src="/icon.png"
          alt=""
          width={compact ? 28 : 34}
          height={compact ? 28 : 34}
          className="brand-mark-image"
        />
      </span>
      {compact ? null : <span>Sua</span>}
    </Link>
  );
}
