/**
 * 暖伴登录页场景插画：窗、暖阳、书桌、茶杯和盆栽。
 * 纯 SVG + CSS 微动效（阳光呼吸、蒸汽），不引入图片资源。
 * 装饰性内容：aria-hidden，不进入读屏与 tab 顺序。
 */
export function LoginScene() {
  return <svg className="login-scene" viewBox="0 0 640 340" aria-hidden="true" focusable="false">
    <g>
      <rect x="70" y="8" width="372" height="228" rx="22" fill="#FFF7E8" stroke="#E3D3BC" strokeWidth="2" />
      <rect x="92" y="30" width="328" height="184" rx="14" fill="#FDF1DD" />
      <circle className="scene-sun" cx="338" cy="96" r="38" fill="#F7C98F" />
      <path d="M92 190h328v24H92z" fill="#F6E7CE" />
      <path d="M170 112c15-20 40-20 55 0M234 106c12-14 30-14 42 0" fill="none" stroke="#D9B98E" strokeWidth="3" strokeLinecap="round" />
      <path d="M92 190h328" stroke="#E7D3B4" strokeWidth="2" />
    </g>

    <rect x="52" y="248" width="560" height="14" rx="7" fill="#E2CDAE" />
    <rect x="104" y="262" width="14" height="56" rx="5" fill="#D8BE9B" />
    <rect x="546" y="262" width="14" height="56" rx="5" fill="#D8BE9B" />

    <g>
      <rect x="430" y="188" width="60" height="60" rx="14" fill="#F3E3CA" stroke="#DCC6A6" strokeWidth="2" />
      <path d="M490 206c16 0 16 28 0 28" fill="none" stroke="#DCC6A6" strokeWidth="6" strokeLinecap="round" />
      <path className="scene-steam" d="M448 170c7-9-7-15 0-24" fill="none" stroke="#D9C3A2" strokeWidth="4" strokeLinecap="round" />
      <path className="scene-steam" d="M466 170c7-9-7-15 0-24" fill="none" stroke="#D9C3A2" strokeWidth="4" strokeLinecap="round" />
    </g>

    <g>
      <path d="M128 226v-40" stroke="#7E8F6B" strokeWidth="4" strokeLinecap="round" />
      <path d="M128 196c-18-5-25-21-20-32 14 0 25 12 27 27" fill="#9DAE87" />
      <path d="M128 188c18-7 22-23 17-34-14 2-23 14-23 30" fill="#84986F" />
      <rect x="108" y="220" width="40" height="28" rx="8" fill="#C98D66" />
      <rect x="108" y="220" width="40" height="8" rx="4" fill="#B87C58" />
    </g>
  </svg>;
}
