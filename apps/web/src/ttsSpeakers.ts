/**
 * 火山豆包大模型 TTS 音色清单。
 *
 * **重要：speaker_id 必须与 VOLC_TTS_RESOURCE_ID 同版本**，否则服务端会回
 * `55000000 resource ID is mismatched with speaker related resource`：
 *
 * - `seed-tts-2.0`  → 仅支持 `*_uranus_bigtts`（豆包 2.0）
 * - `seed-tts-1.0`  → 仅支持 `*_saturn_bigtts` / `*_moon_bigtts` / 普通 `*_bigtts`（豆包 1.0）
 * - `volc.megatts.default` → 双向流式 V3，对应一套独立 speaker_id（这里不列）
 *
 * 当前清单按 `seed-tts-2.0` 组织——这也是仓库默认 `VOLC_TTS_RESOURCE_ID`。
 * 来源：https://www.volcengine.com/docs/6561/1257544
 */
export interface TtsSpeakerOption {
  id: string;
  label: string;
  /** 简短场景说明 */
  hint?: string;
}

export const VOLC_TTS_SPEAKERS: TtsSpeakerOption[] = [
  { id: '', label: '使用服务端默认', hint: '不覆盖，由 VOLC_TTS_SPEAKER 决定' },

  // 通用场景（女声）
  { id: 'zh_female_meilinvyou_uranus_bigtts', label: '魅力女友 2.0', hint: '推荐：闲谈 / 暖场' },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', label: '清新女声 2.0', hint: '播报 / 轻盈' },
  { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0', hint: '中英日多语种' },
  { id: 'zh_female_xiaohe_uranus_bigtts', label: '小何 2.0', hint: '温润书卷气' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快思思 2.0', hint: '播客感、节奏快' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', label: '邻家女孩 2.0', hint: '亲切自然' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '甜美小源 2.0', hint: '甜美' },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', label: '甜美桃子 2.0', hint: '甜美' },

  // 通用场景（男声）
  { id: 'zh_male_m191_uranus_bigtts', label: '云舟 2.0', hint: '推荐：讲解 / 培训' },
  { id: 'zh_male_taocheng_uranus_bigtts', label: '小天 2.0', hint: '稳重清晰' },
  { id: 'zh_male_liufei_uranus_bigtts', label: '刘飞 2.0', hint: '中年稳重' },
  { id: 'zh_male_sophie_uranus_bigtts', label: '魅力苏菲 2.0', hint: '磁性' },
  { id: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅逸辰 2.0', hint: '解说 / 科普' },

  // 客服 / 教育 / 阅读
  { id: 'zh_female_kefunvsheng_uranus_bigtts', label: '暖阳女声 2.0', hint: '客服' },
  { id: 'zh_female_yingyujiaoxue_uranus_bigtts', label: 'Tina 老师 2.0', hint: '中英教学' },
  { id: 'zh_female_xiaoxue_uranus_bigtts', label: '儿童绘本 2.0', hint: '童声朗读' },

  // 视频配音
  { id: 'zh_male_dayi_uranus_bigtts', label: '大壹 2.0', hint: '配音' },
  { id: 'zh_female_liuchangnv_uranus_bigtts', label: '流畅女声 2.0', hint: '配音' },
];
