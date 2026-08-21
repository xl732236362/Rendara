-- Forward fix: pass server-resolved placement into the strict legacy finalizer.
create or replace function public.fulfill_generated_asset_attachment(
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
  v_resolved_template jsonb;
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
  v_resolved_template := p_element_template || jsonb_build_object(
    'x', v_x, 'y', v_y, 'width', v_width, 'height', v_height
  );
  update public.generated_asset_attachment_intents
  set placement_policy = v_effective_policy where id = v_intent.id;
  begin
    v_result := public.fulfill_generated_asset_attachment_legacy(
      p_intent_id, p_claim_fence, v_resolved_template, p_file_template,
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
