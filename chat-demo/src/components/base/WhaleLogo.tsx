import whale from '../../assets/deepseek-whale.png'

/**
 * 官方蓝鲸标记：取自官方 App 图标位图，去掉底色后转成透明 PNG（不重新描摹，保证形状一致）。
 * 尺寸按 UI-SPEC §4 取 48×36 的视觉盒，蓝色部分约 40×30。
 */
export const WhaleLogo = ({ className }: { className?: string }) => (
  <img className={className} src={whale} alt="" aria-hidden="true" draggable={false} />
)
