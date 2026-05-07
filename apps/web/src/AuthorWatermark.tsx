const WATERMARK_TEXT = 'create by liuc，liuc828，17610490xxx';

export function AuthorWatermark() {
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        bottom: 12,
        left: 12,
        zIndex: 50,
        maxWidth: 300,
        fontSize: 14,
        lineHeight: 1.35,
        color: 'rgba(226, 232, 240, 0.5)',
        textShadow: '0 0 1px rgba(0,0,0,0.8), 0 1px 2px rgba(0,0,0,0.6)',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {WATERMARK_TEXT}
    </div>
  );
}
