import type { ReactNode } from "react";

// Placeholder Next.js root layout. Full implementation follows.
export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
