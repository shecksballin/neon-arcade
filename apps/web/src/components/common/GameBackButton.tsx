import { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';

interface GameBackButtonProps {
  onClick: () => void;
  title?: string;
  /** When set, wraps the button in an absolutely-positioned container. */
  positionClassName?: string;
}

/**
 * Shared floating back button (the Pug Shooter / Neon Quiz round chevron).
 * Hides itself whenever the page — or any element in it — is fullscreen, so
 * it never sits over fullscreen gameplay.
 */
export default function GameBackButton({ onClick, title = 'Back to lobby', positionClassName }: GameBackButtonProps) {
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (isFullscreen) return null;

  const button = (
    <button
      onClick={onClick}
      title={title}
      className="p-3 bg-black/50 border border-[#00FFD1]/30 hover:border-[#00FFD1] hover:bg-[#00FFD1]/20 rounded-full text-white backdrop-blur-md transition-all cursor-pointer"
    >
      <ChevronLeft className="w-6 h-6" />
    </button>
  );

  if (!positionClassName) return button;
  return <div className={positionClassName}>{button}</div>;
}
