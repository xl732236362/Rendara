-- Generated image placement execution fix.
-- Keep the existing RPC signatures and security-definer contracts intact.

alter table public.generated_asset_attachment_intents
  drop constraint if exists generated_asset_attachment_placement_shape;

alter table public.generated_asset_attachment_intents
  add constraint generated_asset_attachment_placement_shape check (
    jsonb_typeof(placement_policy) = 'object'
    and (
      placement_policy = '{"kind":"auto_right"}'::jsonb
      or (
        placement_policy->>'kind' = 'explicit'
        and jsonb_typeof(placement_policy->'x') = 'number'
        and jsonb_typeof(placement_policy->'y') = 'number'
        and jsonb_typeof(placement_policy->'width') = 'number'
        and jsonb_typeof(placement_policy->'height') = 'number'
        and (placement_policy->>'width')::numeric > 0
        and (placement_policy->>'height')::numeric > 0
        and placement_policy - array['kind', 'x', 'y', 'width', 'height'] = '{}'::jsonb
      )
      or (
        media_type = 'image'
        and placement_policy->>'kind' = 'relative'
        and jsonb_typeof(placement_policy->'elementId') = 'string'
        and char_length(btrim(placement_policy->>'elementId')) between 1 and 256
        and placement_policy->>'relation' in ('above', 'below', 'left', 'right')
        and jsonb_typeof(placement_policy->'gap') = 'number'
        and (placement_policy->>'gap')::numeric between 0 and 400
        and (
          not (placement_policy ? 'maxWidth')
          or (
            jsonb_typeof(placement_policy->'maxWidth') = 'number'
            and (placement_policy->>'maxWidth')::numeric between 1 and 4096
          )
        )
        and (
          not (placement_policy ? 'maxHeight')
          or (
            jsonb_typeof(placement_policy->'maxHeight') = 'number'
            and (placement_policy->>'maxHeight')::numeric between 1 and 4096
          )
        )
        and placement_policy - array['kind', 'elementId', 'relation', 'gap', 'maxWidth', 'maxHeight'] = '{}'::jsonb
      )
    )
  );

create or replace function public.submit_generation_job(
  p_workspace_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_job_type public.background_job_type,
  p_payload jsonb,
  p_credits_cost integer,
  p_description text,
  p_project_id uuid,
  p_canvas_id uuid,
  p_session_id uuid,
  p_thread_id text,
  p_attachment_intent jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_submission jsonb;
  v_job_id uuid;
  v_intent public.generated_asset_attachment_intents%rowtype;
  v_run public.agent_runs%rowtype;
  v_attempt public.agent_run_attempts%rowtype;
  v_effect public.agent_effects%rowtype;
  v_canvas public.canvases%rowtype;
  v_intent_id uuid;
  v_media_type text;
  v_elements jsonb;
  v_target_count integer;
begin
  v_submission := public.submit_generation_job(
    p_workspace_id, p_user_id, p_idempotency_key, p_request_fingerprint,
    p_job_type, p_payload, p_credits_cost, p_description, p_project_id,
    p_canvas_id, p_session_id, p_thread_id
  );
  if p_attachment_intent is null then return v_submission; end if;
  if jsonb_typeof(p_attachment_intent) <> 'object'
     or (select count(*) from jsonb_object_keys(p_attachment_intent)) <> 9 then
    raise exception using errcode = '22023', message = 'INVALID_ATTACHMENT_INTENT',
      detail = 'invalid_attachment_intent';
  end if;

  v_job_id := (v_submission->'job'->>'id')::uuid;
  v_intent_id := (p_attachment_intent->>'intentId')::uuid;
  v_media_type := p_attachment_intent->>'mediaType';
  if p_canvas_id is null or p_project_id is null or p_session_id is null
     or p_attachment_intent->>'effectKind' <> 'generated_asset_attached'
     or v_media_type not in ('image', 'video')
     or (v_media_type = 'image') <> (p_job_type = 'image_generation')
     or (v_media_type = 'video') <> (p_job_type = 'video_generation') then
    raise exception using errcode = '22023', message = 'INVALID_ATTACHMENT_INTENT',
      detail = 'invalid_attachment_intent';
  end if;

  -- Idempotent replays return the immutable intent before checking the current
  -- attempt lease. This is required after a reconnect or lease handoff.
  select * into v_intent
  from public.generated_asset_attachment_intents
  where job_id = v_job_id and effect_kind = 'generated_asset_attached'
  for update;
  if found then
    if v_intent.id <> v_intent_id
       or v_intent.workspace_id <> p_workspace_id
       or v_intent.project_id <> p_project_id
       or v_intent.canvas_id <> p_canvas_id
       or v_intent.session_id is distinct from p_session_id
       or v_intent.user_id <> p_user_id
       or v_intent.media_type <> v_media_type
       or v_intent.run_id <> (p_attachment_intent->>'runId')::uuid
       or v_intent.attempt_id <> (p_attachment_intent->>'attemptId')::uuid
       or v_intent.fencing_token <> (p_attachment_intent->>'fencingToken')::bigint
       or v_intent.logical_tool_call_id <> p_attachment_intent->>'logicalToolCallId'
       or v_intent.input_digest <> p_attachment_intent->>'inputDigest'
       or v_intent.placement_policy <> p_attachment_intent->'placement' then
      raise exception using errcode = '23505', message = 'ATTACHMENT_INTENT_CONFLICT',
        detail = 'idempotency_conflict';
    end if;
    return v_submission || jsonb_build_object('attachment_intent', to_jsonb(v_intent));
  end if;

  select r.* into v_run
  from public.agent_runs r
  where r.id = (p_attachment_intent->>'runId')::uuid
    and r.user_id = p_user_id and r.workspace_id = p_workspace_id
    and r.project_id = p_project_id and r.canvas_id = p_canvas_id
  for update;
  if not found then raise exception 'run_not_active'; end if;
  select a.* into v_attempt
  from public.agent_run_attempts a
  where a.run_id = v_run.id
    and a.attempt_id = v_run.current_attempt_id
    and a.attempt_id = (p_attachment_intent->>'attemptId')::uuid
    and a.status = 'running'
    and a.fencing_token = (p_attachment_intent->>'fencingToken')::bigint
    and a.lease_expires_at > now()
  for update;
  if not found then raise exception 'run_not_active'; end if;
  select * into v_effect from public.agent_effects e
  where e.run_id = v_run.id
    and e.logical_tool_call_id = p_attachment_intent->>'logicalToolCallId'
  for update;
  if not found or v_effect.status <> 'reserved'
     or v_effect.attempt_id <> v_attempt.attempt_id
     or v_effect.input_digest <> p_attachment_intent->>'inputDigest' then
    raise exception 'agent_effect_conflict';
  end if;

  if p_attachment_intent->'placement'->>'kind' = 'relative' then
    select c.* into v_canvas from public.canvases c
    where c.id = p_canvas_id and c.project_id = p_project_id for update;
    if not found then raise exception using errcode = 'P0002',
      message = 'RELATIVE_TARGET_NOT_FOUND', detail = 'relative_target_not_found';
    end if;
    v_elements := case when jsonb_typeof(v_canvas.content->'elements') = 'array'
      then v_canvas.content->'elements' else '[]'::jsonb end;
    if jsonb_array_length(v_elements) > 10000 then
      raise exception using errcode = '22023', message = 'PLACEMENT_CANVAS_TOO_COMPLEX',
        detail = 'placement_canvas_too_complex';
    end if;
    select count(*) into v_target_count
    from jsonb_array_elements(v_elements) e
    where coalesce((e->>'isDeleted')::boolean, false) = false
      and e->>'id' = p_attachment_intent->'placement'->>'elementId';
    if v_target_count <> 1 then
      raise exception using errcode = 'P0002', message = 'RELATIVE_TARGET_NOT_FOUND',
        detail = 'relative_target_not_found';
    end if;
  end if;

  insert into public.generated_asset_attachment_intents(
    id, job_id, effect_kind, workspace_id, project_id, canvas_id, session_id,
    user_id, media_type, placement_policy, run_id, attempt_id, fencing_token,
    logical_tool_call_id, input_digest
  ) values (
    v_intent_id, v_job_id, 'generated_asset_attached', p_workspace_id,
    p_project_id, p_canvas_id, p_session_id, p_user_id, v_media_type,
    p_attachment_intent->'placement', v_run.id, v_attempt.attempt_id,
    v_attempt.fencing_token, p_attachment_intent->>'logicalToolCallId',
    p_attachment_intent->>'inputDigest'
  ) on conflict (job_id, effect_kind) do nothing;
  select * into strict v_intent
  from public.generated_asset_attachment_intents
  where job_id = v_job_id and effect_kind = 'generated_asset_attached';
  if v_intent.id <> v_intent_id then
    raise exception using errcode = '23505', message = 'ATTACHMENT_INTENT_CONFLICT',
      detail = 'idempotency_conflict';
  end if;
  return v_submission || jsonb_build_object('attachment_intent', to_jsonb(v_intent));
end;
$$;

-- Keep the already-tested mutation/receipt implementation as the finalizer;
-- this wrapper resolves the latest canvas geometry while holding the same
-- intent/canvas transaction lock, then delegates with an immutable explicit
-- placement so the legacy writer remains idempotent.
alter function public.fulfill_generated_asset_attachment(
  uuid, bigint, jsonb, jsonb, uuid, bigint
) rename to fulfill_generated_asset_attachment_legacy;

create function public.fulfill_generated_asset_attachment(
  p_intent_id uuid, p_claim_fence bigint, p_element_template jsonb,
  p_file_template jsonb, p_agent_attempt_id uuid, p_agent_fencing_token bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.generated_asset_attachment_intents%rowtype;
  v_canvas public.canvases%rowtype;
  v_content jsonb;
  v_elements jsonb;
  v_original_policy jsonb;
  v_effective_policy jsonb;
  v_width numeric;
  v_height numeric;
  v_gap numeric;
  v_target_count integer;
  v_target_left numeric;
  v_target_right numeric;
  v_target_top numeric;
  v_target_bottom numeric;
  v_target_center_x numeric;
  v_target_center_y numeric;
  v_max_right numeric;
  v_rightmost_center_y numeric;
  v_x numeric;
  v_y numeric;
  v_kind text;
  v_result jsonb;
begin
  select * into v_intent
  from public.generated_asset_attachment_intents
  where id = p_intent_id for update;
  if not found then raise exception using errcode = 'P0002',
    message = 'ATTACHMENT_INTENT_NOT_FOUND', detail = 'attachment_intent_not_found';
  end if;
  select * into v_canvas from public.canvases
  where id = v_intent.canvas_id for update;
  if not found then raise exception using errcode = 'P0002',
    message = 'ATTACHMENT_CANVAS_NOT_FOUND', detail = 'canvas_not_found';
  end if;
  v_original_policy := v_intent.placement_policy;
  v_kind := v_original_policy->>'kind';
  if v_kind = 'explicit' then
    return public.fulfill_generated_asset_attachment_legacy(
      p_intent_id, p_claim_fence, p_element_template, p_file_template,
      p_agent_attempt_id, p_agent_fencing_token
    );
  end if;
  if jsonb_typeof(p_element_template) <> 'object'
     or jsonb_typeof(p_element_template->'width') <> 'number'
     or jsonb_typeof(p_element_template->'height') <> 'number' then
    raise exception using errcode = '22023', message = 'INVALID_ELEMENT_TEMPLATE',
      detail = 'attachment_integrity_failure';
  end if;
  v_width := (p_element_template->>'width')::numeric;
  v_height := (p_element_template->>'height')::numeric;
  if v_width < 1 or v_width > 16384 or v_height < 1 or v_height > 16384 then
    raise exception using errcode = '22023', message = 'INVALID_ELEMENT_TEMPLATE',
      detail = 'attachment_integrity_failure';
  end if;
  v_content := coalesce(v_canvas.content, '{}'::jsonb);
  v_elements := case when jsonb_typeof(v_content->'elements') = 'array'
    then v_content->'elements' else '[]'::jsonb end;
  if jsonb_array_length(v_elements) > 10000 then
    raise exception using errcode = '22023', message = 'PLACEMENT_CANVAS_TOO_COMPLEX',
      detail = 'placement_canvas_too_complex';
  end if;

  -- Resolve one visual target for relative placement. Deleted targets fall
  -- back to automatic placement; duplicate live IDs are integrity failures.
  if v_kind = 'relative' then
    select count(*) into v_target_count from jsonb_array_elements(v_elements) e
    where coalesce((e->>'isDeleted')::boolean, false) = false
      and e->>'id' = v_original_policy->>'elementId';
    if v_target_count > 1 then
      raise exception using errcode = 'P0001', message = 'RELATIVE_TARGET_AMBIGUOUS',
        detail = 'attachment_integrity_failure';
    end if;
    if v_target_count = 1 then
      select bounds.left_edge, bounds.right_edge, bounds.top_edge,
             bounds.bottom_edge, bounds.center_x, bounds.center_y
      into v_target_left, v_target_right, v_target_top, v_target_bottom,
           v_target_center_x, v_target_center_y
      from (
        select
          (e->>'x')::numeric + (e->>'width')::numeric / 2
            - ((abs(cos(coalesce((e->>'angle')::numeric, 0))) * (e->>'width')::numeric
              + abs(sin(coalesce((e->>'angle')::numeric, 0))) * (e->>'height')::numeric) / 2
              + 1 + greatest(coalesce((e->>'strokeWidth')::numeric, 0), 0) / 2) as left_edge,
          (e->>'x')::numeric + (e->>'width')::numeric / 2
            + ((abs(cos(coalesce((e->>'angle')::numeric, 0))) * (e->>'width')::numeric
              + abs(sin(coalesce((e->>'angle')::numeric, 0))) * (e->>'height')::numeric) / 2
              + 1 + greatest(coalesce((e->>'strokeWidth')::numeric, 0), 0) / 2) as right_edge,
          (e->>'y')::numeric + (e->>'height')::numeric / 2
            - ((abs(sin(coalesce((e->>'angle')::numeric, 0))) * (e->>'width')::numeric
              + abs(cos(coalesce((e->>'angle')::numeric, 0))) * (e->>'height')::numeric) / 2
              + 1 + greatest(coalesce((e->>'strokeWidth')::numeric, 0), 0) / 2) as top_edge,
          (e->>'y')::numeric + (e->>'height')::numeric / 2
            + ((abs(sin(coalesce((e->>'angle')::numeric, 0))) * (e->>'width')::numeric
              + abs(cos(coalesce((e->>'angle')::numeric, 0))) * (e->>'height')::numeric) / 2
              + 1 + greatest(coalesce((e->>'strokeWidth')::numeric, 0), 0) / 2) as bottom_edge,
          (e->>'x')::numeric + (e->>'width')::numeric / 2 as center_x,
          (e->>'y')::numeric + (e->>'height')::numeric / 2 as center_y
        from jsonb_array_elements(v_elements) e
        where coalesce((e->>'isDeleted')::boolean, false) = false
          and e->>'id' = v_original_policy->>'elementId'
        limit 1
      ) bounds;
    end if;
  end if;

  -- Automatic placement uses the rightmost visual bound, with deterministic
  -- tie-breaking. An empty canvas centers the image at the origin.
  select q.right_edge, q.center_y into v_max_right, v_rightmost_center_y
  from (
    select
      (e->>'x')::numeric + (e->>'width')::numeric / 2
        + ((abs(cos(coalesce((e->>'angle')::numeric, 0))) * (e->>'width')::numeric
          + abs(sin(coalesce((e->>'angle')::numeric, 0))) * (e->>'height')::numeric) / 2
          + 1 + greatest(coalesce((e->>'strokeWidth')::numeric, 0), 0) / 2) as right_edge,
      (e->>'y')::numeric + (e->>'height')::numeric / 2 as center_y,
      (e->>'y')::numeric as top_edge,
      e->>'id' as element_id
    from jsonb_array_elements(v_elements) e
    where coalesce((e->>'isDeleted')::boolean, false) = false
    order by right_edge desc, top_edge asc, element_id asc
    limit 1
  ) q;
  if v_kind = 'relative' and v_target_count = 1 then
    v_gap := (v_original_policy->>'gap')::numeric;
    case v_original_policy->>'relation'
      when 'below' then v_x := v_target_center_x - v_width / 2; v_y := v_target_bottom + v_gap;
      when 'above' then v_x := v_target_center_x - v_width / 2; v_y := v_target_top - v_gap - v_height;
      when 'right' then v_x := v_target_right + v_gap; v_y := v_target_center_y - v_height / 2;
      when 'left' then v_x := v_target_left - v_gap - v_width; v_y := v_target_center_y - v_height / 2;
      else raise exception using errcode = 'P0001', message = 'INVALID_RELATIVE_RELATION',
        detail = 'attachment_integrity_failure';
    end case;
  elsif v_max_right is null then
    v_x := -v_width / 2; v_y := -v_height / 2;
  else
    v_x := v_max_right + 80; v_y := v_rightmost_center_y - v_height / 2;
  end if;
  v_effective_policy := jsonb_build_object(
    'kind', 'explicit', 'x', v_x, 'y', v_y,
    'width', v_width, 'height', v_height
  );
  update public.generated_asset_attachment_intents
  set placement_policy = v_effective_policy where id = v_intent.id;
  begin
    v_result := public.fulfill_generated_asset_attachment_legacy(
      p_intent_id, p_claim_fence, p_element_template, p_file_template,
      p_agent_attempt_id, p_agent_fencing_token
    );
    update public.generated_asset_attachment_intents
    set placement_policy = v_original_policy where id = v_intent.id;
    return v_result;
  exception when others then
    update public.generated_asset_attachment_intents
    set placement_policy = v_original_policy where id = v_intent.id;
    raise;
  end;
end;
$$;

revoke all on function public.fulfill_generated_asset_attachment(
  uuid, bigint, jsonb, jsonb, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.fulfill_generated_asset_attachment(
  uuid, bigint, jsonb, jsonb, uuid, bigint
) to service_role;
