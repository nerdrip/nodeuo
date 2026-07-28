// The extractor feeds Sharp raw pixel buffers and only emits PNG/KTX assets.
// Disable vulnerable input decoders that are outside that format boundary.
import sharp from 'sharp';

sharp.block({
  operation: ['VipsForeignLoadNsgif', 'VipsForeignLoadTiff', 'VipsForeignLoadVips'],
});

export default sharp;
