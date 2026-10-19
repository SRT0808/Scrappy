import { useState } from 'react';

export function ProductThumbnail({ src, alt, className = 'size-20' }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/60 ${className}`}>
    {src && !failed ? <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain" onError={() => setFailed(true)} />
      : <span aria-label={`Imagen no disponible para ${alt}`} role="img" className="px-2 text-center text-xs text-muted-foreground">Sin imagen</span>}
  </span>;
}
