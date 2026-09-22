#ifndef SWIFT_OPUS_CTL_H
#define SWIFT_OPUS_CTL_H

#include "opus.h"

static inline int tbv_opus_set_bitrate(OpusEncoder *enc, opus_int32 bitrate) {
    return opus_encoder_ctl(enc, OPUS_SET_BITRATE(bitrate));
}

static inline int tbv_opus_get_lookahead(OpusEncoder *enc, opus_int32 *lookahead) {
    return opus_encoder_ctl(enc, OPUS_GET_LOOKAHEAD(lookahead));
}

#endif /* SWIFT_OPUS_CTL_H */
