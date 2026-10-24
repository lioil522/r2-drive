import { api } from './api';
import { ResourceCache } from './resource-cache';
import type { Dashboard, DriveStatus } from '../shared/types';

export const resourceCache = new ResourceCache((path, signal) => api(path, { signal }),(path,data,before) => {
  if (path === '/status' || path === '/dashboard') {
    const previous = before as DriveStatus | null;
    const current = data as DriveStatus;
    const finished = previous?.hasActiveJobs && !current.hasActiveJobs;
    const completed = current.jobs.some((job) => ['completed','cancelled'].includes(job.status) && previous?.jobs.some((before) => before.id === job.id && before.status !== job.status));
    if (finished || completed) resourceCache.invalidate((key) => key.startsWith('/files') || key === '/shares');
    if (path === '/dashboard') {
      const dashboard = data as Dashboard;
      resourceCache.seed<DriveStatus>('/status',{accounts:dashboard.accounts,buckets:dashboard.buckets,jobs:dashboard.jobs,uploads:dashboard.uploads,hasActiveJobs:dashboard.hasActiveJobs});
    }
  }
});

function changed(path: string): void {
  if (path === '/login' || path === '/logout') { resourceCache.clear(); return; }
  if (/^\/uploads\/[^/]+\/urls$/.test(path) || /^\/accounts\/[^/]+\/test$/.test(path)) return;

  const lists = (key: string) => key === '/status' || key === '/dashboard';
  const files = (key: string) => key.startsWith('/files');
  if (path.startsWith('/public/shares/') || path.startsWith('/shares') || /^\/files\/[^/]+\/shares$/.test(path)) {
    resourceCache.invalidate((key) => key.startsWith('/shares') || key.startsWith('/public/shares/'));
  } else if (path.startsWith('/uploads')) {
    resourceCache.invalidate((key) => lists(key) || path.endsWith('/complete') && files(key));
  } else if (/^\/buckets\/[^/]+\/(settings|cors-auto|domains|events|multipart)/.test(path)) {
    const bucketPath = path.split('/').slice(0, 3).join('/');
    const featurePath = path.endsWith('/cors-auto') ? `${bucketPath}/settings/cors` : path.split('/').slice(0, path.includes('/settings/') ? 5 : 4).join('/');
    resourceCache.invalidate((key) => key === featurePath || key.startsWith(`${featurePath}/`));
  } else {
    resourceCache.invalidate((key) => lists(key) || files(key) || key === '/shares' || key.startsWith('/buckets/') || key.startsWith('/accounts/'));
  }
}

window.addEventListener('resource-changed', (event) => changed((event as CustomEvent<{ path: string }>).detail.path));
window.addEventListener('session-expired', () => resourceCache.clear((path) => !path.startsWith('/public/')));
const resume = () => resourceCache.setActive(document.visibilityState === 'visible' && navigator.onLine);
document.addEventListener('visibilitychange', resume);
window.addEventListener('focus', resume);
window.addEventListener('online', resume);
window.addEventListener('offline', resume);
resume();
