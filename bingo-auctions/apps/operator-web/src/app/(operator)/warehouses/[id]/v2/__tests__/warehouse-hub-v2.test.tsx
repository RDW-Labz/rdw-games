import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { WarehouseHubV2 } from '../WarehouseHubV2';
import { warehouseHubInactiveFixture, warehouseHubV2Fixture } from '../__fixtures__/warehouse-hub-fixture';

describe('WarehouseHubV2', () => {
  it('renders inactive in the title and stepper links', () => {
    const html = renderToString(<WarehouseHubV2 {...warehouseHubInactiveFixture} />);
    expect(html).toContain('Inactive');
    expect(html).toContain('pickup-hours');
  });

  it('staggers setup steps', () => {
    const html = renderToString(<WarehouseHubV2 {...warehouseHubV2Fixture} />);
    expect(html.match(/console-v2-setup-step console-v2-motion-row-in/g)?.length).toBe(
      warehouseHubV2Fixture.steps.length,
    );
  });
});
