import './globals.css';

export const metadata = { title: 'JobFinder', description: 'Job application dashboard' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
