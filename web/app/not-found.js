import Link from "next/link";

export default function NotFound() {
  return (
    <div className="py-24 text-center">
      <p className="text-5xl font-semibold">404</p>
      <p className="mt-3 text-muted">This page does not exist.</p>
      <Link href="/" className="btn-primary mt-6">
        Go to Swap
      </Link>
    </div>
  );
}
