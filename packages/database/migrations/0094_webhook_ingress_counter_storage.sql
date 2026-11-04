-- The opaque endpoint credential scopes both operations. The transaction holds
-- this row lock while core chooses whether to reset, admit or refuse the window.
CREATE FUNCTION app.lock_webhook_ingress_counter(p_endpoint_key_hash character)
RETURNS TABLE(bucket_started_at text,request_count integer,observed_at text,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on
AS $function$
DECLARE v_endpoint_id uuid; v_workspace_id uuid; v_started timestamptz; v_count integer; v_created boolean;
BEGIN
  SELECT endpoint.id,endpoint.workspace_id INTO v_endpoint_id,v_workspace_id
  FROM app.webhook_trigger_endpoints endpoint
  WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash AND endpoint.status='active';
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO app.webhook_endpoint_ingress_limits(endpoint_id,workspace_id,bucket_started_at,request_count)
  VALUES(v_endpoint_id,v_workspace_id,clock_timestamp(),1)
  ON CONFLICT(endpoint_id) DO NOTHING;
  v_created := FOUND;
  SELECT counter.bucket_started_at,counter.request_count INTO v_started,v_count
  FROM app.webhook_endpoint_ingress_limits counter WHERE counter.endpoint_id=v_endpoint_id FOR UPDATE;
  RETURN QUERY SELECT v_started::text,v_count,clock_timestamp()::text,v_created;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION app.store_webhook_ingress_counter(
  p_endpoint_key_hash character,p_expected_window timestamptz,p_expected_count integer,
  p_reset boolean,p_window timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on
AS $function$
BEGIN
  UPDATE app.webhook_endpoint_ingress_limits counter
  SET bucket_started_at=p_window,request_count=CASE WHEN p_reset THEN 1 ELSE counter.request_count+1 END,
    updated_at=clock_timestamp()
  FROM app.webhook_trigger_endpoints endpoint
  WHERE counter.endpoint_id=endpoint.id AND endpoint.endpoint_key_hash=p_endpoint_key_hash
    AND endpoint.status='active' AND counter.bucket_started_at=p_expected_window AND counter.request_count=p_expected_count;
  RETURN FOUND;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_webhook_ingress_counter(character) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.store_webhook_ingress_counter(character,timestamptz,integer,boolean,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_webhook_ingress_counter(character) TO {{app_role}};
GRANT EXECUTE ON FUNCTION app.store_webhook_ingress_counter(character,timestamptz,integer,boolean,timestamptz) TO {{app_role}};
--> statement-breakpoint
DROP FUNCTION app.consume_webhook_ingress_limit(character,integer);
