import { useState } from 'react';

interface SlideImageViewProps {
  url: string;
  title: string;
  fallbackContent: string;
}

export function SlideImageView({ url, title, fallbackContent }: SlideImageViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  return (
    <div style={{ position: 'relative', minHeight: 200 }}>
      {loading && !error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#64748b',
            fontSize: 14,
          }}
        >
          加载幻灯片...
        </div>
      )}
      {error && (
        <div>
          <h2 style={{ margin: '0 0 0.5rem', fontSize: 26, lineHeight: 1.2 }}>{title}</h2>
          <p
            style={{
              margin: 0,
              fontSize: 17,
              lineHeight: 1.5,
              color: '#cbd5e1',
              whiteSpace: 'pre-wrap',
            }}
          >
            {fallbackContent}
          </p>
          <p style={{ color: '#f87171', fontSize: 13, marginTop: '0.5rem' }}>
            幻灯片图片加载失败，已切换为文本展示。
          </p>
        </div>
      )}
      {!error && (
        <img
          src={url}
          alt={`幻灯片 ${title}`}
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setError(true);
          }}
          style={{
            width: '100%',
            maxHeight: 480,
            objectFit: 'contain',
            borderRadius: 8,
            display: loading ? 'none' : 'block',
          }}
        />
      )}
    </div>
  );
}