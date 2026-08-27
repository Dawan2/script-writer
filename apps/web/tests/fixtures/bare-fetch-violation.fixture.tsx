// 反例夹具：故意绕过网络出口直接调用 fetch，供静态检查的拦截用例与证据取样使用。
// 该文件不参与产品构建，也不被 src 下任何模块引用。
export function ProjectCountBadge() {
  const load = async () => {
    const response = await fetch("/api/projects");
    const payload = (await response.json()) as { projects: unknown[] };
    return payload.projects.length;
  };
  return <button type="button" onClick={() => void load()}>刷新数量</button>;
}
