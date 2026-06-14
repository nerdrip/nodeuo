import { describe, it, expect } from 'vitest';
import { CityLoyaltyRegistry, listCities, listTiers } from '../src/systems/city-loyalty.js';

describe('city-loyalty', () => {
  it('award + pointsOf round-trip', () => {
    const reg = new CityLoyaltyRegistry();
    expect(reg.award('alice', 'Britain', 1500)).toBe(1500);
    expect(reg.pointsOf('alice', 'Britain')).toBe(1500);
  });

  it('tier ramp matches threshold table', () => {
    const reg = new CityLoyaltyRegistry();
    expect(reg.tierFor(0).name).toBe('Stranger');
    expect(reg.tierFor(3000).name).toBe('Visitor');
    expect(reg.tierFor(15000).name).toBe('Hero');
    expect(reg.tierFor(30000).name).toBe('Statesman');
  });

  it('declareCitizen requires 2000 points', () => {
    const reg = new CityLoyaltyRegistry();
    reg.award('alice', 'Britain', 1500);
    expect(reg.declareCitizen('alice', 'Britain')).toBe(false);
    reg.award('alice', 'Britain', 1000);
    expect(reg.declareCitizen('alice', 'Britain')).toBe(true);
    expect(reg.status('alice', 'Britain').citizen).toBe(true);
  });

  it('citizenship is exclusive — switching cities un-citizens the prior', () => {
    const reg = new CityLoyaltyRegistry();
    reg.award('alice', 'Britain', 3000);
    reg.award('alice', 'Trinsic', 3000);
    expect(reg.declareCitizen('alice', 'Britain')).toBe(true);
    expect(reg.declareCitizen('alice', 'Trinsic')).toBe(true);
    expect(reg.status('alice', 'Britain').citizen).toBe(false);
    expect(reg.status('alice', 'Trinsic').citizen).toBe(true);
  });

  it('rejects unknown city', () => {
    const reg = new CityLoyaltyRegistry();
    expect(reg.award('alice', 'Atlantis', 100)).toBe(0);
  });

  it('serialize/load round-trip', () => {
    const a = new CityLoyaltyRegistry();
    a.award('alice', 'Britain', 1000);
    a.declareCitizen('alice', 'Britain');     // 1000 < 2000 → declines
    a.award('alice', 'Britain', 1500);
    a.declareCitizen('alice', 'Britain');
    const snap = a.serialize();
    const b = new CityLoyaltyRegistry();
    b.load(snap);
    expect(b.pointsOf('alice', 'Britain')).toBe(2500);
    expect(b.status('alice', 'Britain').citizen).toBe(true);
  });

  it('listCities + listTiers exposed', () => {
    expect(listCities()).toContain('Britain');
    expect(listTiers().length).toBeGreaterThan(5);
  });
});
