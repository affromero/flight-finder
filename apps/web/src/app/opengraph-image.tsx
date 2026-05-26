import { ImageResponse } from 'next/og';

export const alt = 'Flight Finder — The price trail airlines don\'t show you';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#080f1a',
          color: '#ffffff',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            marginBottom: '24px',
          }}
        >
          <svg
            width="64"
            height="64"
            viewBox="0 0 32 32"
            fill="none"
          >
            <path
              d="M8 20 L16 8 L24 20"
              stroke="#06b6d4"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <circle cx="16" cy="8" r="2" fill="#06b6d4" />
          </svg>
          <span
            style={{
              fontSize: '72px',
              fontWeight: 700,
              letterSpacing: '-2px',
            }}
          >
            Flight Finder
          </span>
        </div>
        <span
          style={{
            fontSize: '28px',
            color: '#06b6d4',
            letterSpacing: '1px',
          }}
        >
          The price trail airlines don&apos;t show you
        </span>
        <div
          style={{
            display: 'flex',
            gap: '32px',
            marginTop: '48px',
            fontSize: '20px',
            color: '#94a3b8',
          }}
        >
          <span>Track prices</span>
          <span style={{ color: '#334155' }}>|</span>
          <span>Compare airlines</span>
          <span style={{ color: '#334155' }}>|</span>
          <span>Share charts</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
