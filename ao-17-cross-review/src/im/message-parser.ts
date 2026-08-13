/**
 * 消息解析：@提及还原、图片/文件资源提取。
 */

export interface Mention {
  key: string;      // '@_user_1'
  name: string;     // 显示名，如 'MyBot'
  openId: string;   // 'ou_xxx'
}

/**
 * 从事件的 mentions 数组中提取结构化提及信息。
 */
export function parseMentions(raw: any[] | undefined): Mention[] {
  if (!raw?.length) return [];
  return raw.map((m) => ({
    key: m.key,
    name: m.name ?? '',
    openId: m.id?.open_id ?? '',
  }));
}

/**
 * 把消息文本里的 @_user_N 占位符替换成 @显示名。
 */
export function resolveMentions(text: string, mentions: Mention[]): string {
  let resolved = text;
  for (const m of mentions) {
    resolved = resolved.replaceAll(m.key, `@${m.name}`);
  }
  return resolved.trim();
}

/**
 * 从消息 content 中提取资源 key（image_key / file_key）。
 */
export function extractResourceKeys(
  messageType: string,
  content: string,
): { type: 'image' | 'file'; key: string; fileName?: string }[] {
  const parsed = JSON.parse(content);
  const resources: { type: 'image' | 'file'; key: string; fileName?: string }[] = [];

  if (messageType === 'image' && parsed.image_key) {
    resources.push({ type: 'image', key: parsed.image_key });
  }
  if (messageType === 'file' && parsed.file_key) {
    resources.push({ type: 'file', key: parsed.file_key, fileName: parsed.file_name });
  }

  if (messageType === 'post') {
    const paragraphs: any[][] = parsed.content ?? [];
    for (const el of paragraphs.flat()) {
      if (el.tag === 'img' && el.image_key) {
        resources.push({ type: 'image', key: el.image_key });
      }
    }
  }

  return resources;
}
