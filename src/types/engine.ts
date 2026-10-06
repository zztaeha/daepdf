export interface ParsedImage {
  width:        number
  height:       number
  colorSpace:   'DeviceRGB' | 'DeviceGray' | 'DeviceCMYK'
  data:         Uint8Array
  smask:        Uint8Array | null
  isJpeg:       boolean
  decodeInvert: boolean
  orientation:  number
  // the image's own ICC profile, when it carries one that matches its channels
  icc?:         Uint8Array | null | undefined
}
