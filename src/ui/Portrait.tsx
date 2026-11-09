// Портрет V в виде плоской пиктограммы (как знаки транзита). Не копия игровой модели:
// схематично отражает выбранные цвета, тип причёски, бороду и форму черт лица.
import { useMemo } from 'react';
import type { CharacterState } from '../model/state';
import { slotValue } from '../model/state';
import { shapeParams, type MorphSlot } from '../model/descriptors';

function shade(hex: string | undefined, k: number, fallback = '#8a6a55'): string {
  const h = /^#[0-9a-f]{6}$/i.test(hex ?? '') ? hex! : fallback;
  const n = parseInt(h.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

type HairKind = 'none' | 'buzz' | 'short' | 'long' | 'dreads';

export default function Portrait({ state, className }: { state: CharacterState; className?: string }) {
  const p = useMemo(() => {
    const val = (id: string) => slotValue(state, id);
    const sel: Partial<Record<MorphSlot, number>> = {};
    for (const s of ['eyes', 'nose', 'mouth', 'jaw', 'ear'] as MorphSlot[]) sel[s] = val(s)?.value ?? 0;
    const shape = shapeParams(state.gender, sel);
    const hs = val('hairstyle')?.option;
    const tag = (hs?.tags?.[0] ?? '').toLowerCase();
    const hairNone = (hs?.activates ?? []).some((a) => a.endsWith('_none')) || hs?.meshHint === 'none';
    const hair: HairKind = hairNone ? 'none' : tag === 'buzz' ? 'buzz' : tag === 'long' ? 'long' : tag === 'dreads' ? 'dreads' : 'short';
    const beardOpt = val('beard');
    const beardOn = state.gender === 'male' && !!beardOpt && beardOpt.value !== beardOpt.variant.options[0]?.i;
    const lipsOn = (val('makeupLips_type')?.value ?? 0) !== 0;
    return {
      shape,
      hair,
      skin: val('skin_color')?.option?.hex,
      hairC: val('hair_color')?.option?.hex,
      browC: val('eyebrows_color')?.option?.hex ?? val('hair_color')?.option?.hex,
      iris: val('eyes_color')?.option?.iris ?? val('eyes_color')?.option?.hex,
      beardOn,
      beardC: val('beard_color')?.option?.hex ?? val('hair_color')?.option?.hex,
      lipC: lipsOn ? val('makeupLips_color')?.option?.hex : undefined,
      cyber: (val('cyberware_switcher')?.value ?? 0) !== 0,
      tattoo: (val('facial_tattoo_switcher')?.value ?? 0) !== 0,
      pierce: (val('piercings')?.value ?? 0) !== 0,
      female: state.gender === 'female',
      longHair: hair === 'long',
    };
  }, [state]);

  const s = p.shape;
  const cx = 110;
  const skin = shade(p.skin, 1);
  const skinDark = shade(p.skin, 0.78);
  const hairC = shade(p.hairC, 1, '#2b2320');
  const browC = shade(p.browC, 0.9, '#2b2320');

  // Геометрия головы
  const headW = p.female ? 92 : 100;
  const top = 58;
  const temple = 112;
  const jawY = 168 + s.chinLen * 4;
  const jawHalf = headW / 2 - 8 + s.jawWidth * 7;
  const chinY = 196 + s.chinLen * 9;
  const chinHalf = (p.female ? 13 : 17) + s.jawWidth * 4;
  const head = [
    `M ${cx - headW / 2} ${temple}`,
    `C ${cx - headW / 2} ${top - 6}, ${cx + headW / 2} ${top - 6}, ${cx + headW / 2} ${temple}`,
    `C ${cx + headW / 2 + 1} ${jawY - 22}, ${cx + jawHalf + 2} ${jawY - 8}, ${cx + jawHalf} ${jawY}`,
    `Q ${cx + chinHalf + 8} ${chinY}, ${cx} ${chinY}`,
    `Q ${cx - chinHalf - 8} ${chinY}, ${cx - jawHalf} ${jawY}`,
    `C ${cx - jawHalf - 2} ${jawY - 8}, ${cx - headW / 2 - 1} ${jawY - 22}, ${cx - headW / 2} ${temple}`,
    'Z',
  ].join(' ');

  const eyeY = 128;
  const eyeDX = 21 + s.eyeSize * 1.5;
  const eyeW = 13 + s.eyeSize * 2.2;
  const eyeH = 5.2 + s.eyeOpen * 1.8;
  const tilt = -s.eyeTilt * 6;
  const eye = (side: -1 | 1) => {
    const ex = cx + side * eyeDX;
    return (
      <g key={side} transform={`rotate(${side * tilt} ${ex} ${eyeY})`}>
        <path d={`M ${ex - eyeW} ${eyeY} Q ${ex} ${eyeY - eyeH * 2} ${ex + eyeW} ${eyeY} Q ${ex} ${eyeY + eyeH * 1.6} ${ex - eyeW} ${eyeY} Z`} fill="#f2efe8" />
        <circle cx={ex} cy={eyeY} r={eyeH * 1.05} fill={shade(p.iris, 1.15, '#4b3424')} />
        <circle cx={ex} cy={eyeY} r={eyeH * 0.45} fill="#0b0d12" />
      </g>
    );
  };

  const noseW = 10 + s.noseWidth * 4;
  const noseBot = 160 + s.noseLength * 5;
  const mouthY = 178 + s.chinLen * 2;
  const mouthW = 17 + s.mouthWidth * 4;
  const lipT = 4 + s.lipFull * 2 + (p.female ? 1 : 0);
  const lip = p.lipC ? shade(p.lipC, 1) : shade(p.skin, 0.62);

  const hairBack =
    p.hair === 'long' || p.hair === 'dreads' ? (
      <path
        d={`M ${cx - headW / 2 - 12} ${temple - 10} C ${cx - headW / 2 - 18} 60, ${cx + headW / 2 + 18} 60, ${cx + headW / 2 + 12} ${temple - 10} L ${cx + headW / 2 + 16} ${p.hair === 'long' ? 236 : 210} L ${cx - headW / 2 - 16} ${p.hair === 'long' ? 236 : 210} Z`}
        fill={hairC}
      />
    ) : null;
  const capDepth = p.hair === 'buzz' ? 16 : p.hair === 'short' ? 22 : 26;
  const hairCap =
    p.hair === 'none' ? null : (
      <path
        d={`M ${cx - headW / 2 - (p.hair === 'buzz' ? 0 : 3)} ${temple - 4}
            C ${cx - headW / 2 - 4} ${top - (p.hair === 'buzz' ? 8 : 18)}, ${cx + headW / 2 + 4} ${top - (p.hair === 'buzz' ? 8 : 18)}, ${cx + headW / 2 + (p.hair === 'buzz' ? 0 : 3)} ${temple - 4}
            C ${cx + headW / 2 - 6} ${top + capDepth}, ${cx + 14} ${top + capDepth - 6}, ${cx} ${top + capDepth - 2}
            C ${cx - 14} ${top + capDepth - 6}, ${cx - headW / 2 + 6} ${top + capDepth}, ${cx - headW / 2 - (p.hair === 'buzz' ? 0 : 3)} ${temple - 4} Z`}
        fill={hairC}
        opacity={p.hair === 'buzz' ? 0.88 : 1}
        stroke="rgba(236,233,225,0.14)"
        strokeWidth="1.2"
      />
    );

  return (
    <svg className={className} viewBox="0 0 220 264" role="img" aria-label="Схематичный портрет персонажа">
      <defs>
        <clipPath id="frame">
          <rect width="220" height="264" rx="10" />
        </clipPath>
      </defs>
      <g clipPath="url(#frame)">
        <rect width="220" height="264" fill="#141821" />
        <path d="M0 236 H220" stroke="#262b36" strokeWidth="1" />
        {hairBack}
        {/* плечи и шея */}
        <path d={`M ${cx - 20} 190 L ${cx - 22} 222 L ${cx + 22} 222 L ${cx + 20} 190 Z`} fill={skinDark} />
        <path d={`M 18 264 C 22 232, 60 218, ${cx - 24} 216 L ${cx + 24} 216 C 160 218, 198 232, 202 264 Z`} fill="#232a36" />
        <path d={`M ${cx - 24} 216 L ${cx} 238 L ${cx + 24} 216`} fill="none" stroke="#0b0d12" strokeWidth="3" strokeLinejoin="round" />
        {/* уши */}
        {[-1, 1].map((side) => (
          <ellipse key={side} cx={cx + side * (headW / 2 + 2 + s.earOut * 3)} cy={136} rx={7 + s.earOut * 1.5} ry={13} fill={skinDark} />
        ))}
        <path d={head} fill={skin} />
        {p.beardOn && (
          <path
            d={`M ${cx - jawHalf + 2} ${jawY - 26} C ${cx - jawHalf} ${jawY + 6}, ${cx - chinHalf - 10} ${chinY + 4}, ${cx} ${chinY + 3}
                C ${cx + chinHalf + 10} ${chinY + 4}, ${cx + jawHalf} ${jawY + 6}, ${cx + jawHalf - 2} ${jawY - 26}
                C ${cx + 22} ${mouthY - 4}, ${cx + 10} ${noseBot + 2}, ${cx} ${noseBot + 3}
                C ${cx - 10} ${noseBot + 2}, ${cx - 22} ${mouthY - 4}, ${cx - jawHalf + 2} ${jawY - 26} Z`}
            fill={shade(p.beardC, 1, '#2b2320')}
            opacity={0.92}
          />
        )}
        {hairCap}
        {/* брови */}
        {[-1, 1].map((side) => (
          <path
            key={side}
            d={`M ${cx + side * (eyeDX - eyeW - 2)} ${eyeY - 12} Q ${cx + side * eyeDX} ${eyeY - 19 - s.eyeTilt * 2} ${cx + side * (eyeDX + eyeW + 3)} ${eyeY - 13 - s.eyeTilt * 3}`}
            fill="none"
            stroke={browC}
            strokeWidth={p.female ? 3.2 : 4.4}
            strokeLinecap="round"
          />
        ))}
        {eye(-1)}
        {eye(1)}
        {/* нос */}
        <path d={`M ${cx - 2} ${eyeY + 4} L ${cx - 4} ${noseBot - 6}`} fill="none" stroke={skinDark} strokeWidth="2.5" strokeLinecap="round" />
        <path d={`M ${cx - noseW} ${noseBot - 3} Q ${cx} ${noseBot + 4} ${cx + noseW} ${noseBot - 3}`} fill="none" stroke={skinDark} strokeWidth="3" strokeLinecap="round" />
        {/* губы */}
        <path
          d={`M ${cx - mouthW} ${mouthY} Q ${cx} ${mouthY - lipT * 1.4} ${cx + mouthW} ${mouthY} Q ${cx} ${mouthY + lipT * 1.8} ${cx - mouthW} ${mouthY} Z`}
          fill={lip}
        />
        <path d={`M ${cx - mouthW + 1} ${mouthY} Q ${cx} ${mouthY + 1.5} ${cx + mouthW - 1} ${mouthY}`} fill="none" stroke="#0b0d12" strokeOpacity="0.55" strokeWidth="1.4" />
        {p.cyber && (
          <g stroke="var(--line-mods)" strokeWidth="2.2" strokeLinecap="round" fill="none">
            <path d={`M ${cx + headW / 2 - 8} ${eyeY - 4} l 0 18 l -9 9`} />
            <circle cx={cx + headW / 2 - 8} cy={eyeY - 6} r="2.4" fill="var(--line-mods)" />
          </g>
        )}
        {p.tattoo && (
          <g stroke="#0b0d12" strokeOpacity="0.6" strokeWidth="2" fill="none" strokeLinecap="round">
            <path d={`M ${cx - eyeDX - 4} ${eyeY + 14} l -6 10 m 4 -12 l -6 10`} />
          </g>
        )}
        {p.pierce && (
          <g fill="#d9dde3">
            <circle cx={cx - headW / 2 - 3} cy={146} r="2.6" />
            <circle cx={cx + eyeDX + eyeW + 2} cy={eyeY - 16} r="2" />
          </g>
        )}
      </g>
    </svg>
  );
}
