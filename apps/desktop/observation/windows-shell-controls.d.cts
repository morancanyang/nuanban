import type { ObservationGeometry, ShellControl } from './observation-types.cjs';

/** 清洗后的 shell 候选名称长度上限（与 windows-shell-controls.ps1 保持一致）。 */
export const SHELL_LABEL_MAX_LENGTH: number;
/** 只可能来自伪造/损坏回包的硬上限，超过即拒绝。 */
export const SHELL_LABEL_HARD_LIMIT: number;
/** 清洗 UIA 名称：去控制字符、折叠空白、Trim、NFKC 归一并按上限截断；不合格返回 null。 */
export function normalizedShellLabel(value: unknown): string | null;
/** 结构校验：候选不再限于白名单，但必须仍是“看起来像名称”的本地文本。 */
export function isPublicShellControlLabel(value: unknown): boolean;
/** 策略层校验：名称必须已经清洗且有界（等于自身的归一化结果）。 */
export function isBoundedShellControlLabel(value: unknown): boolean;
/** 校验 helper 回包中的 shell 候选：来源范围、surface、数量上限与同名同位置去重。 */
export function checkedShellControls(controls: unknown, geometry: ObservationGeometry | null): ShellControl[];