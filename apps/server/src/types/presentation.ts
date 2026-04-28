export interface DemoPage {
  pageNo: number;
  title: string;
  content: string;
  script: string;
}

export interface PresentationPageManifest {
  pageNo: number;
  title: string;
  content: string;
}

export interface PresentationScriptEntry {
  pageNo: number;
  script: string;
}

export interface DemoChapter {
  id: string;
  title: string;
  startPage: number;
  endPage?: number;
}

export interface SlideImageEntry {
  pageNo: number;
  file: string;
  width?: number;
  height?: number;
}

export interface SlideManifest {
  slideImages: SlideImageEntry[];
  convertedAt: string;
  sourceDeckFile: string;
  totalPages: number;
}

export interface DemoPresentation {
  presentationId: string;
  title: string;
  totalPages: number;
  deckFile?: string;
  assetBaseUrl?: string;
  /** 转换后的幻灯片图片 URL 基础路径，如 /api/presentations/demo/slides */
  slideImagesBaseUrl?: string;
  /** 转换后的幻灯片图片列表；无 LibreOffice 或未转换时为 undefined */
  slideImages?: SlideImageEntry[];
  /** 可选：演示级知识库，参与问答检索 */
  kb?: KnowledgeBaseChunk[];
  /** 1.1.6：提供 chapters 时「到第X章」才可视为稳定 control */
  chapters?: DemoChapter[];
  pages: DemoPage[];
}

export interface PresentationManifest {
  presentationId: string;
  title: string;
  totalPages: number;
  deckFile?: string;
  chapters?: DemoChapter[];
  pages: PresentationPageManifest[];
}

export interface PresentationScripts {
  scripts: PresentationScriptEntry[];
}

/** 演示级知识库：参与问答检索，不用于 TTS；sourcePages 中 0 表示仅知识库 */
export interface KnowledgeBaseChunk {
  id: string;
  title: string;
  body: string;
}

export interface PresentationKb {
  chunks: KnowledgeBaseChunk[];
}
