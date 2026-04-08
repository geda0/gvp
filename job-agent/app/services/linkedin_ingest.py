import hashlib
import re
from urllib.parse import urlparse, urlunparse


def normalize_linkedin_job_url(url: str) -> str:
  p = urlparse(url.strip())
  if p.scheme not in ('http', 'https'):
    raise ValueError('URL must be http(s)')
  host = (p.netloc or '').lower()
  if 'linkedin.com' not in host:
    raise ValueError('Host must be a linkedin.com domain')
  clean = urlunparse((p.scheme, p.netloc.lower(), p.path or '', '', p.query, ''))
  return clean


def linkedin_external_id(url: str) -> str:
  m = re.search(r'/jobs/view/(\d+)', url)
  if m:
    return m.group(1)
  m = re.search(r'currentJobId=(\d+)', url)
  if m:
    return m.group(1)
  m = re.search(r'jobs/view/[^/]+/(\d+)', url)
  if m:
    return m.group(1)
  return hashlib.sha256(url.encode('utf-8')).hexdigest()[:32]
