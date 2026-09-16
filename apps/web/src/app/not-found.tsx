import { AuthLayout } from '@/components/AuthLayout';
import { ProtectedLink as Link } from '@/components/UnsavedChanges';
import { Icon } from '@/components/Icon';

export default function NotFound() {
  return (
    <AuthLayout
      eyebrow="LET’S GET YOU BACK"
      title="Page not found"
      description="This address may be out of date, or the page may have moved. Your servers are still available from the overview."
    >
      <div className="card stack recovery-actions">
        <Link className="btn" href="/">
          <Icon name="grid" size={18} />
          Back to overview
        </Link>
        <Link href="/login">Go to sign in</Link>
      </div>
    </AuthLayout>
  );
}
