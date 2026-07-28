// Central hardened Sharp entry point. sharp <0.35 inherits libvips decoder
// vulnerabilities in GIF, TIFF, and VIPS loaders; admin rendering only needs
// trusted generated PNG pages and raw RGBA canvases, so block those decoders.
import sharp from 'sharp';

sharp.block({
  operation: ['VipsForeignLoadNsgif', 'VipsForeignLoadTiff', 'VipsForeignLoadVips'],
});

export default sharp;
