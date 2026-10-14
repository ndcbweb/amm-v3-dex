import "./globals.css";
import Shell from "@/components/Shell";

export const metadata = {
  title: "Swap",
  description: "Swap tokens and provide liquidity",
};

const themeBoot = `try{var t=localStorage.getItem("dex-theme");var d=t?t==="dark":true;document.documentElement.classList.toggle("dark",d)}catch(e){}`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
