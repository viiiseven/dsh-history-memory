// Accept SDK-style base URLs without changing explicitly supplied custom routes.
export function serviceEndpoints(value) {
  if (!value) return { embedding: '', models: null, modelsFallback: null };
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('服务地址必须是 HTTP(S) URL，不可包含用户名、密码或片段');
  }
  const path = url.pathname.replace(/\/+$/, '');
  let base;
  if (!path) base = '/v1';
  else if (/\/v\d+(?:beta\d*)?$/.test(path)) base = path;
  else if (path.endsWith('/embeddings')) base = path.slice(0, -'/embeddings'.length);
  else return { embedding: url.href, models: null, modelsFallback: null };
  const at = route => { const target = new URL(url); target.pathname = route; return target.href; };
  const aliyun = url.hostname === 'maas.qianwenaiapi.com'
    || /^(?:dashscope(?:-intl|-us)?|cn-hongkong\.dashscope)\.aliyuncs\.com$/.test(url.hostname)
    || url.hostname.endsWith('.maas.aliyuncs.com');
  return { embedding: at(`${base}/embeddings`), models: at(`${base}/models`),
    modelsFallback: aliyun && base === '/compatible-mode/v1' ? at('/api/v1/models') : null };
}
