UPDATE sh_channel_snapshots
SET current_stream_count=validated_stream_count,
    total_listens=validated_stream_count;
