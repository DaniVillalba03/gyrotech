import type { Metadata } from "next";
import { IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const plex = IBM_Plex_Sans({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Cohete Arandu",
  description: "Cohete 3D controlado por giroscopio USB",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={plex.variable}>
      <body>{children}</body>
    </html>
  );
}
