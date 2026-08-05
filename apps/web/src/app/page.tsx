import { redirect } from 'next/navigation';

/**
 * The root is a signpost, not a page. Auth resolution happens in the app
 * layout, so sending everyone to /servers keeps a single redirect path.
 */
export default function RootPage() {
  redirect('/servers');
}
