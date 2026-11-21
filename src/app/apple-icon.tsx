import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#ffffff",
        borderRadius: "36px",
        border: "6px solid #d4d1ca",
      }}
    >
      <svg width="120" height="120" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M10.5 13.1L5.2 7.8L7.4 5.6L12 10.2L10.5 13.1Z" fill="#111111" fillOpacity="0.28" />
        <path
          d="M10.4 20.5V11.8L16.3 5.9H12.4V3.2H20.8V11.6H18.1V7.7L13.2 12.6V20.5H10.4Z"
          fill="#111111"
        />
      </svg>
    </div>,
    size,
  );
}
