import { describe, expect, it } from 'vitest';
import { backYaw, DEFAULT_YAW, FACE_YAW_LIMIT, faceYaw, nearestDefaultYaw, yawForRow } from './AvatarViewer';

describe('yaw on face close-ups', () => {
  it('keeps a small turn the user made', () => {
    expect(faceYaw(DEFAULT_YAW + 30)).toBe(DEFAULT_YAW + 30);
    expect(faceYaw(DEFAULT_YAW - FACE_YAW_LIMIT)).toBe(DEFAULT_YAW - FACE_YAW_LIMIT);
  });

  it('turns V back to the camera from a profile or back view, by the shortest way', () => {
    expect(faceYaw(DEFAULT_YAW + 90)).toBe(DEFAULT_YAW);
    expect(faceYaw(DEFAULT_YAW + 180)).toBe(DEFAULT_YAW + 360);
    expect(faceYaw(DEFAULT_YAW + 620)).toBe(DEFAULT_YAW + 720);
    expect(faceYaw(DEFAULT_YAW + 700)).toBe(DEFAULT_YAW + 700);
    expect(nearestDefaultYaw(DEFAULT_YAW - 200)).toBe(DEFAULT_YAW - 360);
  });
});

describe('Q/E rotation by hold time', () => {
  it('equal E and Q holds return V to where it was, whatever the frame timing', async () => {
    const { spinYaw, SPIN_DEG_PER_S } = await import('./engine');
    let yaw = DEFAULT_YAW;
    let t = 1000;
    for (let i = 0; i < 70; i++) {
      yaw = spinYaw(yaw, 1, t, t + 650);
      t += 650 + 900;
      yaw = spinYaw(yaw, -1, t, t + 650);
      t += 650 + 300;
    }
    expect(yaw).toBeCloseTo(DEFAULT_YAW, 9);
    expect(spinYaw(0, 1, 0, 1000)).toBeCloseTo(SPIN_DEG_PER_S, 9);
    expect(spinYaw(10, -1, 500, 400)).toBe(10);
  });
});

describe('body scars sit on the back', () => {
  it('the scars row turns V around, the next body row turns her back to the camera', () => {
    expect(yawForRow(DEFAULT_YAW, 'body_tattoo_switcher', 'body_scars_switcher')).toBe(DEFAULT_YAW + 180);
    expect(backYaw(DEFAULT_YAW + 360 + 20)).toBe(DEFAULT_YAW + 360 + 180);
    expect(yawForRow(DEFAULT_YAW + 180, 'body_scars_switcher', 'genitals_switcher')).toBe(DEFAULT_YAW + 360);
    // other rows keep the user's turn
    expect(yawForRow(DEFAULT_YAW + 40, 'breast', 'genitals_switcher')).toBe(DEFAULT_YAW + 40);
  });
});
