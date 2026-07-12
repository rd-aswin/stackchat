import { Inter, Geist } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

export const metadata = {
  title: "StackChat | Real-Time Distributed Chat",
  description: "Production-grade, horizontally scalable real-time chat application dashboard built with Socket.IO, Redis, and PostgreSQL.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${geist.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
