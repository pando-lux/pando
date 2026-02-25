import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ToastSSEBridge from "@/components/ToastSSEBridge";
import { AuthProvider } from "@/lib/auth-context";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pando — The Open Network",
  description: "Search. Build. Earn. No barriers. No tracking. No ads.",
};

const themeScript = `(function(){try{var t=localStorage.getItem("pando-theme");var d=t?t==="dark":window.matchMedia("(prefers-color-scheme:dark)").matches;if(d)document.documentElement.classList.add("dark")}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100`}
      >
        <AuthProvider>
          <ToastSSEBridge />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
